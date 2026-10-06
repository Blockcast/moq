//! A catalog publishes one finished group and then stays quiet. The route
//! carrying it dies while a reader is still subscribed, and another route that
//! still holds that group takes over. A reader who never received the group
//! must get it. Media hides a resume that starts at the next group, because
//! the next group arrives; a catalog does not produce one.

mod support;

use std::time::Duration;

use moq_net::{Error, Hop, Timestamp, Version, origin, track};
use support::harness::{MockConnectOptions, MockPair, connect_mock};

const TIMEOUT: Duration = Duration::from_secs(5);

const VERSIONS: &[&str] = &["moq-lite-06", "moq-lite-07-wip", "moq-transport-16", "moq-transport-22"];

fn produce_origin(hop: u64) -> origin::Producer {
	let (producer, driver) = origin::Producer::new(origin::Config::new(Hop::new(hop).unwrap()));
	support::harness::spawn(driver);
	producer
}

async fn link(version: Version, from: &origin::Producer, to: &origin::Producer) -> MockPair {
	let mut options = MockConnectOptions::new(version);
	options.server_publish = Some(from.consume());
	options.client_subscribe = Some(to.clone());
	connect_mock(options).await
}

fn abort(pair: MockPair) {
	pair.server.abort(Error::Cancel);
	pair.client.abort(Error::Cancel);
}

async fn settle() {
	moq_net_sim::sleep(Duration::from_millis(500)).await;
}

/// `P -> A -> R` is serving a finished catalog. `P -> B -> R` is standing by.
/// `A` dies. A new reader on `R` has to receive the snapshot `P` still holds.
async fn round(version: &str) -> Result<(), String> {
	let version: Version = version.parse().unwrap();
	let publisher = produce_origin(1);
	let relay_a = produce_origin(2);
	let relay_b = produce_origin(3);
	let subscriber = produce_origin(4);

	let broadcast = publisher.create_broadcast("live").unwrap();
	let track = broadcast.create_track("catalog.json", None).unwrap();
	broadcast.announce(Default::default()).unwrap();
	let mut group = track.append_group().unwrap();
	group.write_frame(Timestamp::ZERO, b"snapshot").unwrap();
	group.finish().unwrap();

	let p_a = link(version, &publisher, &relay_a).await;
	let _p_b = link(version, &publisher, &relay_b).await;
	let a_r = link(version, &relay_a, &subscriber).await;

	let consumer = subscriber.consume();
	consumer.routed("live").await.unwrap();
	let remote = consumer.request_broadcast("live").await.unwrap();
	let mut early = remote
		.track("catalog.json")
		.unwrap()
		.subscribe(None)
		.await
		.map_err(|err| format!("{version}: early subscribe: {err}"))?;
	let mut got = moq_net_sim::timeout(TIMEOUT, early.recv_group())
		.await
		.map_err(|_| format!("{version}: the first reader never got the catalog"))?
		.map_err(|err| format!("{version}: first read: {err}"))?
		.ok_or_else(|| format!("{version}: catalog track ended empty"))?;
	let frame = moq_net_sim::timeout(TIMEOUT, got.read_frame())
		.await
		.map_err(|_| format!("{version}: snapshot frame missing"))?
		.map_err(|err| format!("{version}: snapshot read: {err}"))?
		.ok_or_else(|| format!("{version}: snapshot group ended empty"))?;
	if frame.payload.as_ref() != b"snapshot" {
		return Err(format!("{version}: first frame was {:?}", frame.payload));
	}

	// `B` is connected before `A` dies, and the first reader stays subscribed, so
	// the relay resumes rather than parking an idle cache.
	let _b_r = link(version, &relay_b, &subscriber).await;
	settle().await;
	abort(p_a);
	abort(a_r);
	settle().await;

	let start = track.subscription().map(|sub| sub.start);
	let subscribed = moq_net_sim::timeout(TIMEOUT, remote.track("catalog.json").unwrap().subscribe(None)).await;
	let mut late = match subscribed {
		Err(_) => return Err(format!("{version}: late subscribe never resolved; upstream {start:?}")),
		Ok(Err(err)) => return Err(format!("{version}: late subscribe failed: {err}; upstream {start:?}")),
		Ok(Ok(late)) => late,
	};
	match moq_net_sim::timeout(TIMEOUT, late.recv_group()).await {
		Err(_) => Err(format!(
			"{version}: subscribe resolved but no group arrived; upstream {start:?}"
		)),
		Ok(Err(err)) => Err(format!("{version}: late read failed: {err}; upstream {start:?}")),
		Ok(Ok(None)) => Err(format!("{version}: catalog ended with no group; upstream {start:?}")),
		Ok(Ok(Some(mut group))) => {
			let frame = moq_net_sim::timeout(TIMEOUT, group.read_frame())
				.await
				.map_err(|_| {
					format!(
						"{version}: late group {0} had no frame; upstream {start:?}",
						group.sequence
					)
				})?
				.map_err(|err| format!("{version}: late frame: {err}; upstream {start:?}"))?
				.ok_or_else(|| format!("{version}: late group ended empty; upstream {start:?}"))?;
			if group.sequence == 0 && frame.payload.as_ref() == b"snapshot" {
				Ok(())
			} else {
				Err(format!(
					"{version}: late reader got group {} {:?}",
					group.sequence, frame.payload
				))
			}
		}
	}
}

#[moq_net_sim::test]
async fn a_quiet_catalog_reaches_a_late_reader_after_its_route_dies() {
	let mut failures = Vec::new();
	for version in VERSIONS {
		match moq_net_sim::timeout(Duration::from_secs(30), round(version)).await {
			Ok(Ok(())) => {}
			Ok(Err(err)) => failures.push(err),
			Err(_) => failures.push(format!("{version}: scenario timed out")),
		}
	}
	assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// A peer resumes one group past a finished catalog before anyone else has
/// fetched it, so the relay's upstream subscription is created past the only
/// group. A fresh reader must still receive that group.
#[moq_net_sim::test]
async fn a_quiet_catalog_reaches_a_fresh_reader_when_a_peer_resumes_past_it() {
	let mut failures = Vec::new();
	for version in VERSIONS {
		match moq_net_sim::timeout(Duration::from_secs(30), resume_past(version)).await {
			Ok(Ok(())) => {}
			Ok(Err(err)) => failures.push(err),
			Err(_) => failures.push(format!("{version}: scenario timed out")),
		}
	}
	assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

async fn resume_past(version: &str) -> Result<(), String> {
	let label = version;
	let version: Version = label.parse().unwrap();
	let publisher = produce_origin(1);
	let relay = produce_origin(2);
	let resuming = produce_origin(3);
	let fresh = produce_origin(4);

	let broadcast = publisher.create_broadcast("live").unwrap();
	let track = broadcast.create_track("catalog.json", None).unwrap();
	broadcast.announce(Default::default()).unwrap();
	let mut group = track.append_group().unwrap();
	group.write_frame(Timestamp::ZERO, b"snapshot").unwrap();
	group.finish().unwrap();

	let _upstream = link(version, &publisher, &relay).await;
	let _resume_link = link(version, &relay, &resuming).await;
	let _fresh_link = link(version, &relay, &fresh).await;

	let resume_consumer = resuming.consume();
	resume_consumer.routed("live").await.unwrap();
	let resume_remote = resume_consumer.request_broadcast("live").await.unwrap();
	// Held until this function returns. Dropping it would cancel the upstream
	// subscription and let the fresh reader open a new one at the live edge.
	let _resume = moq_net_sim::spawn(async move {
		let _sub = resume_remote
			.track("catalog.json")
			.unwrap()
			.subscribe(track::Subscription::default().with_start(track::Position::group(1)))
			.await;
		moq_net_sim::sleep(Duration::from_secs(60)).await;
	});

	let mut upstream = None;
	for _ in 0..40 {
		moq_net_sim::sleep(Duration::from_millis(50)).await;
		if let Some(sub) = track.subscription() {
			upstream = Some(sub.start);
			if sub.start == Some(track::Position::group(1)) {
				break;
			}
		}
	}
	let fresh_consumer = fresh.consume();
	if fresh_consumer.routed("live").await.is_none() {
		return Err(format!(
			"{label}: the fresh peer never saw the broadcast; upstream {upstream:?}"
		));
	}
	let fresh_remote = fresh_consumer
		.request_broadcast("live")
		.await
		.map_err(|err| format!("{label}: fresh broadcast: {err}; upstream {upstream:?}"))?;
	let fresh_track = fresh_remote
		.track("catalog.json")
		.map_err(|err| format!("{label}: fresh track: {err}; upstream {upstream:?}"))?;

	let subscribed = moq_net_sim::timeout(TIMEOUT, fresh_track.subscribe(None)).await;
	let start = track.subscription().map(|sub| sub.start);
	let mut late = match subscribed {
		Err(_) => {
			return Err(format!(
				"{label}: fresh subscribe never resolved; upstream during {upstream:?} now {start:?}"
			));
		}
		Ok(Err(err)) => {
			return Err(format!(
				"{label}: fresh subscribe failed: {err}; upstream during {upstream:?} now {start:?}"
			));
		}
		Ok(Ok(late)) => late,
	};
	match moq_net_sim::timeout(TIMEOUT, late.recv_group()).await {
		Err(_) => {
			let end = track.subscription().map(|sub| sub.start);
			Err(format!(
				"{label}: subscribe resolved but no group arrived; upstream during {upstream:?} now {end:?}"
			))
		}
		Ok(Err(err)) => Err(format!(
			"{label}: fresh read failed: {err}; upstream during {upstream:?} now {start:?}"
		)),
		Ok(Ok(None)) => Err(format!(
			"{label}: catalog ended with no group; upstream during {upstream:?} now {start:?}"
		)),
		Ok(Ok(Some(mut group))) => {
			let frame = moq_net_sim::timeout(TIMEOUT, group.read_frame())
				.await
				.map_err(|_| {
					format!(
						"{label}: fresh group {} had no frame; upstream during {upstream:?} now {start:?}",
						group.sequence
					)
				})?
				.map_err(|err| format!("{label}: fresh frame: {err}; upstream during {upstream:?} now {start:?}"))?
				.ok_or_else(|| {
					format!("{label}: fresh group ended empty; upstream during {upstream:?} now {start:?}")
				})?;
			if group.sequence == 0 && frame.payload.as_ref() == b"snapshot" {
				Ok(())
			} else {
				Err(format!(
					"{label}: fresh reader got group {} {:?}; upstream during {upstream:?} now {start:?}",
					group.sequence, frame.payload
				))
			}
		}
	}
}
