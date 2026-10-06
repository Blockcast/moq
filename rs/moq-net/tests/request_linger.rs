//! An upstream SUBSCRIBE or FETCH outlives its last reader by a short linger.
//!
//! A reader that re-subscribes, seeks, or blips is back within it and rides the request
//! still in flight, so the relay neither cancels upstream nor asks again.

mod support;

use std::time::Duration;

use bytes::Bytes;
use moq_net::{Hop, Timestamp, Version, origin, track};
use support::harness::peer;

/// Inside the relay's one second request linger.
const WITHIN: Duration = Duration::from_millis(500);
/// Past it.
const PAST: Duration = Duration::from_secs(2);

fn produce_origin(hop: u64) -> origin::Producer {
	let (producer, driver) = origin::Producer::new(origin::Config::new(Hop::new(hop).unwrap()));
	support::harness::spawn(driver);
	producer
}

async fn a_resubscribe_within_the_linger_rides_the_subscription(version: &str) {
	let version: Version = version.parse().unwrap();
	let publisher = produce_origin(1);
	let relay = produce_origin(2);
	let _pair = peer(version, &publisher, &relay).await;

	let broadcast = publisher.create_broadcast("room").unwrap();
	let track = broadcast.create_track("video", None).unwrap();
	broadcast.announce(Default::default()).unwrap();
	moq_net_sim::sleep(Duration::from_secs(1)).await;

	let remote = relay.consume().request_broadcast("room").await.unwrap();
	let mut sub = remote.track("video").unwrap().subscribe(None).await.unwrap();
	let mut group = track.append_group().unwrap();
	group.write_frame(Timestamp::ZERO, Bytes::from_static(b"a")).unwrap();
	group.finish().unwrap();
	sub.recv_group().await.unwrap().expect("the first group");

	// The reader blips: the relay keeps its upstream subscription meanwhile.
	drop(sub);
	moq_net_sim::sleep(WITHIN).await;
	assert!(
		track.demand().is_used(),
		"{version}: the relay canceled upstream inside the linger"
	);

	let mut sub = remote.track("video").unwrap().subscribe(None).await.unwrap();
	moq_net_sim::sleep(WITHIN).await;
	assert!(
		track.demand().is_used(),
		"{version}: the returning reader rides the subscription"
	);
	let mut group = track.append_group().unwrap();
	group.write_frame(Timestamp::ZERO, Bytes::from_static(b"b")).unwrap();
	group.finish().unwrap();
	// The relay's cached group may come first.
	let mut next = moq_net_sim::timeout(PAST, async {
		loop {
			let group = sub.recv_group().await.unwrap().unwrap();
			if group.sequence == 1 {
				return group;
			}
		}
	})
	.await
	.unwrap_or_else(|_| panic!("{version}: the returning reader stalled"));
	assert_eq!(&next.read_frame().await.unwrap().unwrap().payload[..], b"b");

	// Gone for good: canceled upstream once the linger runs out, not before.
	drop(sub);
	let left = moq_net_sim::now();
	moq_net_sim::timeout(PAST * 2, track.demand().unused())
		.await
		.unwrap_or_else(|_| panic!("{version}: the relay never canceled upstream"))
		.unwrap();
	assert!(
		moq_net_sim::now() - left > WITHIN,
		"{version}: canceled after {:?}, before the linger ran out",
		moq_net_sim::now() - left
	);
}

#[moq_net_sim::test]
async fn a_resubscribe_within_the_linger_rides_the_subscription_lite06() {
	a_resubscribe_within_the_linger_rides_the_subscription("moq-lite-06").await;
}

#[moq_net_sim::test]
async fn a_resubscribe_within_the_linger_rides_the_subscription_lite07() {
	a_resubscribe_within_the_linger_rides_the_subscription("moq-lite-07-wip").await;
}

#[moq_net_sim::test]
async fn a_resubscribe_within_the_linger_rides_the_subscription_ietf19() {
	a_resubscribe_within_the_linger_rides_the_subscription("moq-transport-19").await;
}

async fn a_refetch_within_the_linger_rides_the_fetch(version: &str) {
	let version: Version = version.parse().unwrap();
	let publisher = produce_origin(1);
	let relay = produce_origin(2);
	let _pair = peer(version, &publisher, &relay).await;

	let broadcast = publisher.create_broadcast("room").unwrap();
	let mut dynamic = broadcast.dynamic();
	broadcast.announce(Default::default()).unwrap();
	moq_net_sim::sleep(Duration::from_secs(1)).await;

	let consumer = relay.consume().request_broadcast("room").await.unwrap();
	let mut waiting = Box::pin(consumer.track("video").unwrap().fetch_group(0, None));
	let request = match futures::future::select(std::pin::pin!(dynamic.requested_track()), &mut waiting).await {
		futures::future::Either::Left((request, _)) => request.expect("the track request reaches the publisher"),
		futures::future::Either::Right(_) => panic!("nothing answered the track"),
	};
	let groups = request.dynamic();
	let _track = request.accept(track::Info::default());
	let request = match futures::future::select(std::pin::pin!(groups.requested_group()), &mut waiting).await {
		futures::future::Either::Left((request, _)) => request.expect("the fetch reaches the publisher"),
		futures::future::Either::Right(_) => panic!("nothing answered the fetch"),
	};

	// The reader gives up before the publisher answers, then asks again.
	drop(waiting);
	moq_net_sim::sleep(WITHIN).await;
	assert!(
		request.demand().is_used(),
		"{version}: the relay canceled the FETCH inside the linger"
	);
	let mut refetch = Box::pin(consumer.track("video").unwrap().fetch_group(0, None));
	let again = std::pin::pin!(groups.requested_group());
	let past = std::pin::pin!(moq_net_sim::sleep(PAST));
	let waited = futures::future::select(&mut refetch, past);
	match futures::future::select(again, waited).await {
		futures::future::Either::Left(_) => panic!("{version}: the relay fetched the group again"),
		futures::future::Either::Right((futures::future::Either::Left(_), _)) => {
			panic!("{version}: nothing was served yet")
		}
		futures::future::Either::Right((futures::future::Either::Right(_), _)) => {}
	}

	let mut group = request.accept(None).unwrap();
	group
		.write_frame(Timestamp::ZERO, Bytes::from_static(b"segment"))
		.unwrap();
	group.finish().unwrap();
	let mut fetched = moq_net_sim::timeout(PAST, refetch)
		.await
		.unwrap_or_else(|_| panic!("{version}: the refetch stalled"))
		.expect("the in-flight FETCH serves the returning reader");
	assert_eq!(&fetched.read_frame().await.unwrap().unwrap().payload[..], b"segment");
}

#[moq_net_sim::test]
async fn a_refetch_within_the_linger_rides_the_fetch_lite06() {
	a_refetch_within_the_linger_rides_the_fetch("moq-lite-06").await;
}

#[moq_net_sim::test]
async fn a_refetch_within_the_linger_rides_the_fetch_lite07() {
	a_refetch_within_the_linger_rides_the_fetch("moq-lite-07-wip").await;
}

#[moq_net_sim::test]
async fn a_refetch_within_the_linger_rides_the_fetch_ietf19() {
	a_refetch_within_the_linger_rides_the_fetch("moq-transport-19").await;
}
