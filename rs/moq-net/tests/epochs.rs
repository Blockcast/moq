//! Epoch identity is metadata, including across protocol and route boundaries.
mod support;

use moq_net::{Epoch, Error, Hop, Timestamp, Version, broadcast, origin, track};
use support::harness::{MockConnectOptions, connect_mock, spawn};

const A: &str = "01900000-0000-7000-8000-000000000001";
const B: &str = "01900000-0001-7000-8000-000000000001";

fn id(epoch: &str) -> broadcast::Id {
	broadcast::Id::from("live").with_epoch(epoch.parse::<Epoch>().unwrap())
}

fn origin(hop: u64) -> origin::Producer {
	let (origin, driver) = origin::Producer::new(origin::Config::new(Hop::new(hop).unwrap()));
	spawn(driver);
	origin
}

fn publish(origin: &origin::Producer, epoch: &str, bytes: &'static [u8]) -> (broadcast::Producer, track::Producer) {
	let source = origin.create_broadcast(id(epoch)).unwrap();
	let track = source.create_track("video", None).unwrap();
	let mut group = track.append_group().unwrap();
	group.write_frame(Timestamp::ZERO, bytes).unwrap();
	group.finish().unwrap();
	source.announce(Default::default()).unwrap();
	(source, track)
}

async fn read(source: &broadcast::Consumer) -> Vec<u8> {
	let mut track = source.track("video").unwrap().subscribe(None).await.unwrap();
	let mut group = track.recv_group().await.unwrap().unwrap();
	group.read_frame().await.unwrap().unwrap().payload.to_vec()
}

#[moq_net_sim::test]
async fn epochs_select_content_without_changing_paths() {
	let source = origin(1);
	let _a = publish(&source, A, b"a");
	let a = source.consume().request_broadcast(id(A)).await.unwrap();
	let _b = publish(&source, B, b"b");
	let b = source.consume().request_broadcast(id(B)).await.unwrap();
	assert_eq!(a.info().path.as_str(), "live");
	assert_eq!(a.info().epoch.as_ref().unwrap().as_str(), A);
	assert_eq!(read(&a).await, b"a");
	assert_eq!(read(&b).await, b"b");
	assert!(!a.is_clone(&b));
}

#[moq_net_sim::test]
async fn a_stale_epoch_never_falls_back_to_the_current_instance() {
	let source = origin(1);
	let _b = publish(&source, B, b"b");
	assert!(matches!(
		source.consume().request_broadcast(id(A)).await,
		Err(Error::Unroutable)
	));
}

#[moq_net_sim::test]
async fn unknown_and_known_requests_are_not_merged() {
	for known_first in [false, true] {
		let source = origin(1);
		let _a = publish(&source, A, b"a");
		let consumer = source.consume();
		let first = if known_first { id(A) } else { "live".into() };
		let second = if known_first { "live".into() } else { id(A) };
		let first = consumer.request_broadcast(first).await.unwrap();
		let second = consumer.request_broadcast(second).await.unwrap();
		assert!(!first.is_clone(&second));
		assert_eq!(read(&first).await, b"a");
		assert_eq!(read(&second).await, b"a");
	}
}

#[moq_net_sim::test]
async fn an_unknown_subscription_does_not_adopt_a_new_epoch() {
	let source = origin(1);
	let a = publish(&source, A, b"a");
	let bare = source.consume().request_broadcast("live").await.unwrap();
	assert_eq!(read(&bare).await, b"a");
	let _b = publish(&source, B, b"b");
	let again = source.consume().request_broadcast("live").await.unwrap();
	assert!(bare.is_clone(&again));
	assert_eq!(read(&again).await, b"a");
	a.0.unannounce();
	// Existing handles may drain cached tracks, but never acquire B's new tracks.
	let track = bare.track("new-track").unwrap();
	assert!(track.subscribe(None).await.is_err());
}

#[moq_net_sim::test]
async fn announced_epochs_survive_a_lite_session() {
	for alpn in ["moq-lite-05", "moq-lite-06", "moq-lite-07-wip"] {
		let source = origin(1);
		let sink = origin(2);
		let a = publish(&source, A, b"a");
		let mut options = MockConnectOptions::new(alpn.parse::<Version>().unwrap());
		options.server_publish = Some(source.consume());
		options.client_subscribe = Some(sink.clone());
		let _pair = connect_mock(options).await;
		let mut announced = sink.consume().announced();
		loop {
			if let Some(moq_net::announce::Event::Start(event)) = announced.next().await {
				assert_eq!(event.prefix.as_str(), "live");
				assert_eq!(event.route.epoch.as_ref().unwrap().as_str(), A);
				break;
			}
		}
		let pinned = sink.consume().request_broadcast(id(A)).await.unwrap();
		assert_eq!(read(&pinned).await, b"a");
		// B is announced before A's next track request reaches the publisher.
		let _b = publish(&source, B, b"b");
		let late = a.0.create_track("late", None).unwrap();
		let mut group = late.append_group().unwrap();
		group.write_frame(Timestamp::ZERO, b"still-a".as_ref()).unwrap();
		group.finish().unwrap();
		let mut sub = pinned.track("late").unwrap().subscribe(None).await.unwrap();
		let mut group = sub.recv_group().await.unwrap().unwrap();
		assert_eq!(group.read_frame().await.unwrap().unwrap().payload.as_ref(), b"still-a");
	}
}

#[moq_net_sim::test]
async fn legacy_protocols_announce_plain_paths_without_claiming_an_epoch() {
	for alpn in ["moq-lite-04", "moq-transport-19", "moq-transport-22"] {
		let source = origin(1);
		let sink = origin(2);
		let _a = publish(&source, A, b"a");
		let mut options = MockConnectOptions::new(alpn.parse::<Version>().unwrap());
		options.server_publish = Some(source.consume());
		options.client_subscribe = Some(sink.clone());
		let _pair = connect_mock(options).await;
		let mut announced = sink.consume().announced();
		loop {
			if let Some(moq_net::announce::Event::Start(event)) = announced.next().await {
				assert_eq!(event.prefix.as_str(), "live");
				assert_eq!(event.route.epoch, None);
				break;
			}
		}
		let bare = sink.consume().request_broadcast("live").await.unwrap();
		assert_eq!(read(&bare).await, b"a");
		assert!(matches!(
			sink.consume().request_broadcast(id(A)).await,
			Err(Error::Unroutable)
		));
	}
}

#[moq_net_sim::test]
async fn route_repricing_cannot_change_identity() {
	let origin = origin(1);
	let source = origin.create_broadcast(id(A)).unwrap();
	assert!(matches!(
		source.announce(origin::Route::default().with_epoch(B.parse().unwrap())),
		Err(Error::ProtocolViolation)
	));
	let route = origin
		.dynamic("live", origin::Route::default().with_epoch(A.parse().unwrap()))
		.unwrap();
	assert!(matches!(
		route.update(origin::Route::default().with_epoch(B.parse().unwrap())),
		Err(Error::ProtocolViolation)
	));
}
