//! A track's timing survives the wire: readers learn it when the subscription is accepted.
//!
//! Wires that can't declare a timescale (pre-Lite05) deliver every track untimed; Lite05
//! and Lite06 always declare one, so an untimed track goes out timed; moq-transport
//! declares TIMESCALE only for a timed track.

mod support;

use std::time::Duration;

use moq_net::{Hop, Timescale, Version, track};
use support::harness::{MockConnectOptions, connect_mock};

const TEST_TIMEOUT: Duration = Duration::from_secs(10);

fn produce_origin(hop: u64) -> moq_net::origin::Producer {
	let (producer, driver) = moq_net::origin::Producer::new(moq_net::origin::Config::new(Hop::new(hop).unwrap()));
	tokio::spawn(support::harness::run(driver));
	producer
}

/// The scale each track arrives with: `(timed track, untimed track)`.
async fn received(version: &str) -> (Option<Timescale>, Option<Timescale>) {
	let publisher = produce_origin(1);
	let consumer_origin = produce_origin(2);

	let broadcast = publisher.create_broadcast("room").unwrap();
	let info = track::Info::default().with_timescale(Timescale::MICRO);
	let _video = broadcast.create_track("video", info).unwrap().timed().unwrap();
	let _chat = broadcast.create_track("chat", None).unwrap().untimed().unwrap();
	broadcast.announce(Default::default()).unwrap();

	let mut options = MockConnectOptions::new(version.parse::<Version>().unwrap());
	options.server_publish = Some(publisher.consume());
	options.client_subscribe = Some(consumer_origin.clone());
	let _pair = connect_mock(options).await;

	let consumer = consumer_origin.consume();
	consumer.routed("room").await.unwrap();
	let remote = consumer.request_broadcast("room").await.unwrap();

	let mut scales = Vec::new();
	for name in ["video", "chat"] {
		let subscriber = remote.track(name).unwrap().subscribe(None).await.unwrap();
		scales.push(match subscriber.timing() {
			track::Timing::Timed(timed) => Some(timed.timescale()),
			track::Timing::Untimed(_) => None,
		});
	}
	(scales[0], scales[1])
}

#[tokio::test]
async fn timing_is_learned_from_the_wire() {
	tokio::time::timeout(TEST_TIMEOUT, async {
		assert_eq!(received("moq-lite-03").await, (None, None));
		assert_eq!(
			received("moq-lite-05").await,
			(Some(Timescale::MICRO), Some(Timescale::MILLI))
		);
		assert_eq!(received("moq-transport-17").await, (Some(Timescale::MICRO), None));
	})
	.await
	.expect("timed out");
}
