//! Arm B of BLO-41217 (BLO-41277): the maintainer-shaped MMTP->MoQ mapping,
//! measured end to end through a real `moq-relay` against **unpatched**
//! `moq-dev/moq`.
//!
//! The shape under test is the one kixelated offered on moq-dev/moq#4926 after
//! declining opaque object properties, non-contiguous object IDs and a subgroup
//! layer in `moq-net`:
//!
//! 1. repair goes on its **own MoQ track**, not its own subgroup;
//! 2. the **object-ID delta** is a payload prefix under a declared schema,
//!    instead of a non-contiguous object ID;
//! 3. **per-object MMTP metadata** rides the same prefix, instead of object
//!    properties (this is where FEC Source Info would go if it moved off MoQT
//!    object extension `0x11`).
//!
//! Every count printed here is per flow -- the source track and each repair
//! track -- so it is comparable with arm A's `[relay-ingest/...] sent=/received=`
//! lines from the BLO-40794 spike.
//!
//! Nothing in `moq-net` is patched. The only build flag is `--features
//! test-support`, which is upstream's own relay fixture (`rs/moq-relay/src/
//! test_support.rs`, feature declared in `rs/moq-relay/Cargo.toml`), not a
//! Blockcast addition. If this file passes against a stock checkout, arm B's
//! carried patch is zero files and zero lines.
//!
//! ## Ordering matters, and getting it wrong measures the cache instead
//!
//! The publisher must write **into a live subscription**. An earlier draft of
//! this harness wrote every group before connecting and then subscribed; the
//! relay served only the most recent group (`sent=8 received=4
//! groups={1: 4}`), because nothing had subscribed while group 0 was current.
//! That measures moq-net's cache retention, not the MMTP mapping. Every test
//! below therefore connects both ends, subscribes every flow, and only then
//! publishes.

use std::collections::BTreeMap;
use std::time::Duration;

use moq_net::track::{Position, Subscription};
use moq_tokio::moq_net;

const TIMEOUT: Duration = Duration::from_secs(10);

// ---------------------------------------------------------------------------
// The arm-B payload schema
// ---------------------------------------------------------------------------
//
// Fixed-width and self-delimiting, so a receiver on any MoQT draft reads the
// same bytes. This is deliberately NOT a QUIC varint: MoQT redefined the
// session varint at draft-17, which is the same reason libmmt's FEC Source Info
// encodes its optional field fixed-width (see `vectors/fec-source-info`).
//
//     object_id_delta        u8      1 == contiguous with the previous object
//     sbn                    u32 BE  \ FEC Source Info, the bytes that today
//     esi                    u32 BE  / live in MoQT object extension 0x11
//     media                  bytes
//
// 9 bytes. The 12-byte FEC Source Info variant (with Original Object Length)
// would make it 13; see the report for why the optional-field discrimination is
// the one thing that does NOT survive the move for free.
const PREFIX_LEN: usize = 9;

fn encode(delta: u8, sbn: u32, esi: u32, media: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(PREFIX_LEN + media.len());
	out.push(delta);
	out.extend_from_slice(&sbn.to_be_bytes());
	out.extend_from_slice(&esi.to_be_bytes());
	out.extend_from_slice(media);
	out
}

#[derive(Debug, PartialEq, Eq)]
struct Decoded {
	delta: u8,
	sbn: u32,
	esi: u32,
	media: Vec<u8>,
}

fn decode(buf: &[u8]) -> Decoded {
	assert!(buf.len() >= PREFIX_LEN, "payload shorter than the arm-B prefix");
	Decoded {
		delta: buf[0],
		sbn: u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]),
		esi: u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]),
		media: buf[PREFIX_LEN..].to_vec(),
	}
}

/// What one flow (one MoQ track) sent and what came back out of the relay.
#[derive(Default, Debug)]
struct Flow {
	sent: usize,
	received: usize,
	/// Every object-ID delta observed on the receive side, in arrival order.
	deltas: Vec<u8>,
	/// Group sequence -> objects received in it.
	groups: BTreeMap<u64, usize>,
	/// Every SBN observed, in arrival order.
	sbns: Vec<u32>,
}

impl Flow {
	fn report(&self, label: &str) -> String {
		let contiguous = self.deltas.iter().all(|&d| d == 1);
		format!(
			"[arm-b/{label}] sent={} received={} dropped={} object_id_deltas={:?} contiguous={} groups={:?}",
			self.sent,
			self.received,
			// Saturating: a flow whose `sent` was not populated must not panic
			// in the middle of a measurement.
			self.sent.saturating_sub(self.received),
			self.deltas,
			contiguous,
			self.groups,
		)
	}
}

// ---------------------------------------------------------------------------
// Topology: publisher -> real moq-relay -> subscriber
// ---------------------------------------------------------------------------

/// A running relay, a connected publisher origin, and a subscriber that has
/// already resolved the broadcast. Tracks are created by the caller, which then
/// subscribes before publishing anything.
struct Harness {
	broadcast: moq_net::broadcast::Producer,
	consumer: moq_net::broadcast::Consumer,
	trigger: moq_relay::shutdown::Trigger,
	running: tokio::task::JoinHandle<anyhow::Result<()>>,
	// Dropping either connection tears the session down, so they are held for
	// the lifetime of the test even though nothing reads them.
	_pub_connection: moq_tokio::Connection,
	_sub_connection: moq_tokio::Connection,
	_pub_client: moq_tokio::Client,
	_sub_client: moq_tokio::Client,
	_pub_origin: moq_net::origin::Producer,
}

fn client() -> moq_tokio::Client {
	let mut config = moq_tokio::connect::Config::default();
	config.tls.insecure = Some(true);
	config.once = Some(true);
	config.bind = Some("127.0.0.1:0".parse().expect("parse bind"));
	config.init(Default::default()).expect("client init")
}

async fn connect_once(
	client: moq_tokio::Client,
	url: url::Url,
) -> moq_tokio::Result<(moq_tokio::Client, moq_tokio::Connection)> {
	let connection = client.clone().with_reconnect(false).connect(url).established().await?;
	Ok((client, connection))
}

/// The next announced route and whether it is active, skipping the live marker.
async fn next_update(announced: &mut moq_net::announce::Consumer) -> Option<(moq_net::announce::Announce, bool)> {
	loop {
		return match announced.next().await? {
			moq_net::announce::Event::Start(route) | moq_net::announce::Event::Update(route) => Some((route, true)),
			moq_net::announce::Event::End(route) => Some((route, false)),
			moq_net::announce::Event::Live => continue,
		};
	}
}

/// Stand the whole topology up and leave it ready for tracks to be created,
/// subscribed, and only then published.
async fn harness(tracks: &[&str]) -> (Harness, Vec<moq_net::track::Producer>) {
	let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
	let fixture = moq_relay::test_relay().await.expect("bind test relay");
	let url = fixture.url.clone();
	let ready = fixture.relay.ready();
	let trigger = fixture.relay.shutdown_trigger().clone();
	let running = tokio::spawn(fixture.relay.run());
	ready.wait().await.expect("relay ready");

	// ── publisher ───────────────────────────────────────────────────
	let pub_origin = moq_tokio::origin::spawn();
	let broadcast = pub_origin.create_broadcast("mmtp").expect("create broadcast");
	broadcast.announce(Default::default()).expect("announce");
	let producers: Vec<_> = tracks
		.iter()
		.map(|name| broadcast.create_track(*name, None).expect("create track"))
		.collect();

	let (pub_client, pub_connection) = tokio::time::timeout(
		TIMEOUT,
		connect_once(client().with_publisher(&pub_origin), url.clone()),
	)
	.await
	.expect("publisher connect timeout")
	.expect("publisher connect");

	// ── subscriber ──────────────────────────────────────────────────
	let sub_origin = moq_tokio::origin::spawn();
	let sub_consumer = sub_origin.consume();
	let mut announcements = sub_consumer.announced();
	let (sub_client, sub_connection) =
		tokio::time::timeout(TIMEOUT, connect_once(client().with_subscriber(sub_origin), url.clone()))
			.await
			.expect("subscriber connect timeout")
			.expect("subscriber connect");

	let (update, active) = tokio::time::timeout(TIMEOUT, next_update(&mut announcements))
		.await
		.expect("announcement timeout")
		.expect("origin closed");
	assert!(active, "expected an announce");
	let path = moq_net::Path::new(update.prefix.as_str()).to_owned();
	let consumer = sub_consumer.request_broadcast(&path).await.expect("resolve broadcast");

	(
		Harness {
			broadcast,
			consumer,
			trigger,
			running,
			_pub_connection: pub_connection,
			_sub_connection: sub_connection,
			_pub_client: pub_client,
			_sub_client: sub_client,
			_pub_origin: pub_origin,
		},
		producers,
	)
}

impl Harness {
	/// Subscribe one flow from group 0 at the given moq-net priority.
	///
	/// NOTE the scales are INVERTED against the catalog: MoQT
	/// SUBSCRIBER_PRIORITY is lower-first (draft-ramadan-moq-fec puts repair in
	/// 192..255), while `Subscription::priority` is higher-preempts-lower. The
	/// catalog value must be mapped, never copied.
	async fn subscribe(&self, name: &str, priority: Option<u8>) -> moq_net::track::Subscriber {
		let mut subscription = Subscription::default().with_start(Position::group(0));
		if let Some(priority) = priority {
			subscription = subscription.with_priority(priority);
		}
		self.consumer
			.track(name)
			.expect("track announced")
			.subscribe(subscription)
			.await
			.expect("subscribe")
	}

	async fn shutdown(self) {
		self.broadcast.close();
		self.trigger.start();
		let _ = self.running.await;
	}
}

/// Read every object the subscription delivers until the track ends, decoding
/// the arm-B prefix off each one.
async fn drain(track: &mut moq_net::track::Subscriber, flow: &mut Flow) {
	while let Ok(Some(mut group)) = tokio::time::timeout(TIMEOUT, track.recv_group())
		.await
		.unwrap_or(Ok(None))
	{
		let sequence = group.sequence;
		while let Ok(Some(frame)) = tokio::time::timeout(TIMEOUT, group.read_frame())
			.await
			.unwrap_or(Ok(None))
		{
			let decoded = decode(&frame.payload);
			flow.received += 1;
			flow.deltas.push(decoded.delta);
			flow.sbns.push(decoded.sbn);
			*flow.groups.entry(sequence).or_default() += 1;
		}
	}
}

/// Start draining a flow concurrently with publication.
///
/// This is not a convenience: a live stream has a reader running while the
/// publisher produces. Draining only after the last group is written makes the
/// relay's upstream subscription floor at the newest group
/// (`live_floor`, `rs/moq-net/src/model/track.rs`), and the measurement then
/// reports one group instead of all of them. See
/// `arm_b_burst_before_the_subscription_is_established` for that case measured
/// deliberately.
fn spawn_drain(mut track: moq_net::track::Subscriber) -> tokio::task::JoinHandle<Flow> {
	tokio::spawn(async move {
		let mut flow = Flow::default();
		drain(&mut track, &mut flow).await;
		flow
	})
}

/// Time for a subscription to reach the publisher through the relay, and for
/// one group to be picked up before the next is appended. A live publisher
/// paces itself by frame cadence; these tests stand in for that.
const SETTLE: Duration = Duration::from_millis(300);
const GROUP_GAP: Duration = Duration::from_millis(50);

/// Publish `blocks` FEC blocks across one source track and its repair layers.
///
/// One MoQ group per FEC block per track, so block identity is the group
/// sequence on every flow. `layout` is (producer, first ESI, symbol count,
/// media tag) per track. Paced by `GROUP_GAP`, standing in for a live
/// publisher's frame cadence.
async fn publish_blocks(blocks: u32, layout: &[(&moq_net::track::Producer, u32, u32, &[u8])], sent: &mut [Flow]) {
	for sbn in 0..blocks {
		for (i, (producer, first_esi, count, tag)) in layout.iter().enumerate() {
			let mut group = producer.append_group().expect("append group");
			for esi in *first_esi..(*first_esi + *count) {
				group
					.write_frame(moq_net::Timestamp::ZERO, encode(1, sbn, esi, tag).as_slice())
					.expect("write frame");
				sent[i].sent += 1;
			}
			group.finish().expect("finish group");
		}
		tokio::time::sleep(GROUP_GAP).await;
	}
}

// ---------------------------------------------------------------------------
// AC 1: objects sent vs received per flow, with AL-FEC repair live
// ---------------------------------------------------------------------------

/// Three flows on one broadcast -- a source track and two layered repair tracks
/// -- round-trip through a real relay with every object intact and every
/// object-ID delta equal to 1.
///
/// The delta assertion is the measurement that matters: it is the condition
/// kixelated's cache-fragmentation objection turns on. Repair on its own track
/// gives each flow its own numbering space, so the gaps that forced arm A to
/// ask for non-contiguous object IDs do not exist here.
#[tokio::test]
async fn arm_b_source_and_two_repair_tracks_round_trip() {
	// The Blockcast FEC catalog model, one MoQ track per catalog track:
	//   "video"       packaging: media,      fec.repairTrack -> "video/fec/0"
	//   "video/fec/0" packaging: fec-repair, depends ["video"], repairLayer 0
	//   "video/fec/1" packaging: fec-repair, depends ["video"], repairLayer 1
	let names = ["video", "video/fec/0", "video/fec/1"];
	let (h, producers) = harness(&names).await;

	// Subscribe and start reading BEFORE publishing, so the measurement is of
	// the mapping and not of cache retention.
	let mut drains = Vec::new();
	for name in names {
		drains.push(spawn_drain(h.subscribe(name, None).await));
	}
	tokio::time::sleep(SETTLE).await;

	// Two FEC source blocks. Per block: 4 source symbols, 2 layer-0 repair
	// symbols, 1 layer-1 repair symbol. Repair ESIs continue past K on the
	// wire, but they are objects 0..P-1 of their own track, so the delta
	// stays 1.
	let mut sent = [Flow::default(), Flow::default(), Flow::default()];
	publish_blocks(
		2,
		&[
			(&producers[0], 0, 4, b"src"),
			(&producers[1], 4, 2, b"rep0"),
			(&producers[2], 6, 1, b"rep1"),
		],
		&mut sent,
	)
	.await;
	for producer in &producers {
		producer.finish().expect("finish track");
	}

	let mut got = Vec::new();
	for (i, handle) in drains.into_iter().enumerate() {
		let mut flow = handle.await.expect("drain task");
		flow.sent = sent[i].sent;
		got.push(flow);
	}

	for (flow, label) in got.iter().zip(["source", "repair-layer-0", "repair-layer-1"]) {
		println!("{}", flow.report(label));
	}

	assert_eq!(got[0].received, 8, "source objects received");
	assert_eq!(got[1].received, 4, "repair layer 0 objects received");
	assert_eq!(got[2].received, 2, "repair layer 1 objects received");
	for (flow, label) in got.iter().zip(names) {
		assert_eq!(flow.sent, flow.received, "{label}: no object lost end to end");
		assert!(
			flow.deltas.iter().all(|&d| d == 1),
			"{label}: every object-ID delta must be 1 -- separate tracks mean no gaps"
		);
		assert_eq!(
			flow.groups.keys().copied().collect::<Vec<_>>(),
			vec![0, 1],
			"{label}: both FEC blocks delivered"
		);
	}

	h.shutdown().await;
}

// ---------------------------------------------------------------------------
// AC 2: repair-track subscribe and prioritise
// ---------------------------------------------------------------------------

/// A subscriber joins a subset of the repair layers and gives each flow a
/// distinct delivery priority, on stock `moq-net`.
///
/// This is the behaviour the Blockcast catalog already models with
/// `packaging: "fec-repair"` + `priority` 192..255 and the `joinedRepairCount`
/// vs `fecTotalRepairCount` split.
#[tokio::test]
async fn arm_b_repair_tracks_subscribe_and_prioritise() {
	let names = ["video", "video/fec/0", "video/fec/1"];
	let (h, producers) = harness(&names).await;

	// Catalog priorities: source media is most important, then repair layer 0.
	// Layer 1 is published but deliberately NOT joined.
	let plan: [(&str, u8); 2] = [("video", 200), ("video/fec/0", 100)];
	let mut drains = Vec::new();
	for (name, priority) in plan {
		drains.push(spawn_drain(h.subscribe(name, Some(priority)).await));
	}
	tokio::time::sleep(SETTLE).await;

	let mut sent = [Flow::default(), Flow::default(), Flow::default()];
	publish_blocks(
		2,
		&[
			(&producers[0], 0, 4, b"src"),
			(&producers[1], 4, 2, b"rep0"),
			(&producers[2], 6, 1, b"rep1"),
		],
		&mut sent,
	)
	.await;
	for producer in &producers {
		producer.finish().expect("finish track");
	}

	let mut joined = Vec::new();
	for (i, (name, priority)) in plan.into_iter().enumerate() {
		let mut flow = drains.remove(0).await.expect("drain task");
		flow.sent = sent[i].sent;
		println!("{} priority={}", flow.report(name), priority);
		joined.push(flow.received);
	}

	assert_eq!(joined[0], 8, "source delivered in full at priority 200");
	assert_eq!(joined[1], 4, "repair layer 0 delivered in full at priority 100");

	// Layer 1 was published but never subscribed. That is `joinedRepairCount` <
	// catalog total: the receiver joined P=2 of a catalog P=3, and the relay
	// forwarded nothing for the track it was not asked for.
	println!(
		"[arm-b/joined] published_repair_layers=2 joined_repair_layers=1 \
		 catalog_repair_symbols_per_block=3 joined_repair_symbols_per_block=2 \
		 unjoined_objects_published={} unjoined_objects_received=0",
		sent[2].sent
	);

	h.shutdown().await;
}

// ---------------------------------------------------------------------------
// AC 3: FEC block alignment across source and repair tracks, including the race
// where two tracks' subscriptions start at different group IDs
// ---------------------------------------------------------------------------

/// The race kixelated names explicitly ("a race condition where base and
/// enhancement layer subscriptions start at different group IDs"). Source
/// subscribes from group 0, repair from group 2, and we record exactly what the
/// receiver gets on each flow.
///
/// This is the one real cost of the separate-track mapping, and the measurement
/// is the point: alignment is the application's job, because `moq-net` has no
/// cross-track synchronisation primitive and the maintainer declined to add
/// one.
#[tokio::test]
async fn arm_b_subscriptions_starting_at_different_groups() {
	let names = ["video", "video/fec/0"];
	let (h, producers) = harness(&names).await;

	// Deliberately misaligned starts: source from block 0, repair from block 2.
	let src = h.subscribe("video", None).await;
	let rep = h
		.consumer
		.track("video/fec/0")
		.expect("track announced")
		.subscribe(Subscription::default().with_start(Position::group(2)))
		.await
		.expect("subscribe repair");
	let src_drain = spawn_drain(src);
	let rep_drain = spawn_drain(rep);
	tokio::time::sleep(SETTLE).await;

	// Four FEC blocks, one MoQ group each, on both flows.
	let mut sent = [Flow::default(), Flow::default()];
	publish_blocks(
		4,
		&[(&producers[0], 0, 4, b"src"), (&producers[1], 4, 2, b"rep0")],
		&mut sent,
	)
	.await;
	for producer in &producers {
		producer.finish().expect("finish track");
	}

	let mut src_flow = src_drain.await.expect("source drain");
	src_flow.sent = sent[0].sent;
	let mut rep_flow = rep_drain.await.expect("repair drain");
	rep_flow.sent = sent[1].sent;

	println!("{}", src_flow.report("race/source@group0"));
	println!("{}", rep_flow.report("race/repair@group2"));

	let src_groups: Vec<u64> = src_flow.groups.keys().copied().collect();
	let rep_groups: Vec<u64> = rep_flow.groups.keys().copied().collect();
	let aligned: Vec<u64> = src_groups.iter().filter(|g| rep_groups.contains(g)).copied().collect();
	let source_only: Vec<u64> = src_groups.iter().filter(|g| !rep_groups.contains(g)).copied().collect();
	println!(
		"[arm-b/race] source_groups={src_groups:?} repair_groups={rep_groups:?} \
		 repairable_blocks={aligned:?} unprotected_blocks={source_only:?}"
	);

	// The receiver gets every source block, and repair only for the blocks whose
	// repair subscription had started. Blocks below that floor are delivered
	// WITHOUT repair, and the receiver must say so: counting them as covered
	// claims protection that does not exist, and the lie only surfaces when a
	// symbol goes missing and nothing can recover it.
	//
	// The refusal is libmmt's, not this harness's -- `mmt_fec::RepairJoin`
	// reports 0 repair symbols below the repair track's first block and names
	// the unprotected blocks to the host (BLO-41723). What is asserted here is
	// the transport fact that rule is fed: which groups each flow actually
	// delivered.
	assert_eq!(src_groups, vec![0, 1, 2, 3], "source delivered every block");
	assert_eq!(rep_groups, vec![2, 3], "repair floored at its start group");
	assert_eq!(aligned, vec![2, 3], "blocks with both flows present");
	assert_eq!(source_only, vec![0, 1], "blocks delivered without repair");

	// The SBN in the payload prefix is what lets the receiver notice the
	// misalignment at all: group sequence and SBN agree on both flows, so the
	// application can align them without any moq-net support.
	assert_eq!(src_flow.sbns, vec![0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
	assert_eq!(rep_flow.sbns, vec![2, 2, 3, 3]);

	h.shutdown().await;
}

/// The same misalignment arriving by accident rather than by request.
///
/// Nothing reads while the publisher bursts every block, so the relay's
/// upstream subscription floors at the newest group. Both flows lose the same
/// earlier blocks here -- but nothing in the mapping *guarantees* they lose the
/// same ones, because the two tracks' subscriptions are established
/// independently. This is the sharper form of the race, and it is the reason
/// the SBN has to be in the payload: the receiver cannot align on group
/// sequence it never saw.
#[tokio::test]
async fn arm_b_burst_before_the_subscription_is_established() {
	let names = ["video", "video/fec/0"];
	let (h, producers) = harness(&names).await;

	let src = h.subscribe("video", None).await;
	let rep = h.subscribe("video/fec/0", None).await;

	// No settle, no pacing, no concurrent reader: a burst.
	let mut sent = [Flow::default(), Flow::default()];
	for sbn in 0..4u32 {
		for (i, (producer, first_esi, count, tag)) in [
			(&producers[0], 0u32, 4u32, &b"src"[..]),
			(&producers[1], 4, 2, &b"rep0"[..]),
		]
		.iter()
		.enumerate()
		{
			let mut group = producer.append_group().expect("append group");
			for esi in *first_esi..(*first_esi + *count) {
				group
					.write_frame(moq_net::Timestamp::ZERO, encode(1, sbn, esi, tag).as_slice())
					.expect("write frame");
				sent[i].sent += 1;
			}
			group.finish().expect("finish group");
		}
	}
	for producer in &producers {
		producer.finish().expect("finish track");
	}

	let mut src_flow = Flow::default();
	let mut rep_flow = Flow::default();
	{
		let mut src = src;
		let mut rep = rep;
		drain(&mut src, &mut src_flow).await;
		drain(&mut rep, &mut rep_flow).await;
	}
	src_flow.sent = sent[0].sent;
	rep_flow.sent = sent[1].sent;

	println!("{}", src_flow.report("burst/source"));
	println!("{}", rep_flow.report("burst/repair"));
	let src_groups: Vec<u64> = src_flow.groups.keys().copied().collect();
	let rep_groups: Vec<u64> = rep_flow.groups.keys().copied().collect();
	println!(
		"[arm-b/burst] source_groups={src_groups:?} repair_groups={rep_groups:?} \
		 source_blocks_lost={} repair_blocks_lost={}",
		4 - src_groups.len(),
		4 - rep_groups.len()
	);

	// Whatever did arrive is intact and contiguous: the loss is whole blocks,
	// never a hole inside one.
	assert!(!src_groups.is_empty(), "some source block arrived");
	assert!(
		src_flow.deltas.iter().all(|&d| d == 1) && rep_flow.deltas.iter().all(|&d| d == 1),
		"loss is whole-group, never a gap inside a group"
	);
	assert!(
		src_flow.received < src_flow.sent,
		"a burst into an unestablished subscription does lose blocks"
	);

	h.shutdown().await;
}

// ---------------------------------------------------------------------------
// AC 4: relay cache and FETCH under contiguous object IDs
// ---------------------------------------------------------------------------

/// A FETCH for one past block, served through the relay cache, with every
/// object-ID delta equal to 1.
///
/// This is the condition kixelated's objection turns on: with contiguous IDs
/// the relay can serve a range from cache without querying upstream for holes.
#[tokio::test]
async fn arm_b_fetch_group_under_contiguous_object_ids() {
	let names = ["video"];
	let (h, producers) = harness(&names).await;

	// A live subscription keeps the relay cache populated for the FETCH below.
	let live = h.subscribe("video", None).await;
	let live_drain = spawn_drain(live);
	tokio::time::sleep(SETTLE).await;

	let mut sent = [Flow::default()];
	publish_blocks(3, &[(&producers[0], 0, 4, b"src")], &mut sent).await;
	producers[0].finish().expect("finish track");

	let mut live_flow = live_drain.await.expect("live drain");
	live_flow.sent = sent[0].sent;
	println!("{}", live_flow.report("fetch/live-subscription"));
	assert_eq!(live_flow.received, 12, "every object reached the relay cache");

	// FETCH block 1 by group sequence, not by subscribing and waiting.
	let track = h.consumer.track("video").expect("track announced");
	let mut fetched = Flow::default();
	fetched.sent = 4;
	let mut group = tokio::time::timeout(TIMEOUT, track.fetch_group(1, None))
		.await
		.expect("fetch timeout")
		.expect("fetch group 1");
	while let Ok(Some(frame)) = tokio::time::timeout(TIMEOUT, group.read_frame())
		.await
		.unwrap_or(Ok(None))
	{
		let decoded = decode(&frame.payload);
		fetched.received += 1;
		fetched.deltas.push(decoded.delta);
		fetched.sbns.push(decoded.sbn);
		*fetched.groups.entry(1).or_default() += 1;
		assert_eq!(decoded.sbn, 1, "fetched block carries its own SBN");
	}

	println!("{}", fetched.report("fetch/group1"));
	assert_eq!(fetched.received, 4, "FETCH served the whole block");
	assert!(
		fetched.deltas.iter().all(|&d| d == 1),
		"no holes for the relay to query upstream for"
	);

	h.shutdown().await;
}
