//! Loopback group delivery latency through the selected native QUIC backend.

use criterion::{BenchmarkId, Throughput};
use criterion::{Criterion, criterion_group, criterion_main};
use moq_tokio::{moq_net, origin};

fn latency(c: &mut Criterion) {
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("runtime");
	let mut bench = c.benchmark_group("quic_group_delivery");

	for scheme in ["moqt", "https"] {
		for size in [1200, 64 * 1024, 1024 * 1024] {
			bench.throughput(Throughput::Bytes(size as u64));
			bench.bench_with_input(BenchmarkId::new(scheme, size), &size, |b, &size| {
				let (track, mut received, client, connection, serving) = runtime.block_on(async {
					let publisher = origin::spawn();
					let broadcast = publisher.create_broadcast("latency").expect("broadcast");
					broadcast.announce(Default::default()).expect("announce");
					let track = broadcast.create_track("data", None).expect("track");

					let mut listen = moq_tokio::listen::Config::default();
					listen.bind = Some("127.0.0.1:0".parse().unwrap());
					listen.tls.generate = vec!["localhost".into()];
					let mut server = listen
						.init(Default::default())
						.expect("server")
						.listen()
						.await
						.expect("listen");
					let addr = server.local_addr().expect("address");
					let serving = tokio::spawn(async move {
						let session = server
							.accept()
							.await
							.expect("accept")
							.with_publisher(&publisher)
							.ok()
							.await
							.expect("handshake");
						let _broadcast = broadcast;
						let _ = session.closed().await;
					});

					let subscriber = origin::spawn();
					let consumer = subscriber.consume();
					let mut announcements = consumer.announced();
					let mut connect = moq_tokio::connect::Config::default();
					connect.bind = Some("127.0.0.1:0".parse().unwrap());
					connect.tls.insecure = Some(true);
					let client = connect
						.init(Default::default())
						.expect("client")
						.with_subscriber(subscriber);
					let url = url::Url::parse(&format!("{scheme}://localhost:{}", addr.port())).unwrap();
					let connection = client
						.clone()
						.with_reconnect(false)
						.connect(url)
						.established()
						.await
						.expect("connect");
					loop {
						match announcements.next().await.expect("announcement") {
							moq_net::announce::Event::Start(route) | moq_net::announce::Event::Update(route) => {
								assert_eq!(route.prefix.as_str(), "latency");
								break;
							}
							moq_net::announce::Event::Live => continue,
							moq_net::announce::Event::End(_) => panic!("broadcast ended"),
						}
					}
					let remote = consumer.request_broadcast("latency").await.expect("remote broadcast");
					let received = remote.track("data").unwrap().subscribe(None).await.expect("subscribe");
					(track, received, client, connection, serving)
				});
				let payload = vec![0x5a; size];
				let mut sequence = 0;

				b.iter_custom(|iterations| {
					runtime.block_on(async {
						let start = std::time::Instant::now();
						for _ in 0..iterations {
							let mut group = track.append_group().expect("group");
							// Advance media time so the cache can evict previous groups.
							let timestamp = moq_net::Timestamp::from_secs(sequence).expect("timestamp");
							sequence += 1;
							group.write_frame(timestamp, &payload).expect("write");
							group.finish().expect("finish");
							let mut group = received.recv_group().await.expect("receive").expect("group");
							let frame = group.read_frame().await.expect("read").expect("frame");
							assert_eq!(frame.payload.len(), size);
						}
						start.elapsed()
					})
				});
				runtime.block_on(async {
					drop(connection);
					serving.await.expect("server task");
					drop(client);
				});
			});
		}
	}
	bench.finish();
}

criterion_group!(benches, latency);
criterion_main!(benches);
