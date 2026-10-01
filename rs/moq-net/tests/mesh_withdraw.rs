//! Broadcasts withdrawn from a meshed cluster retract everywhere, once.
//!
//! Every relay holds a route through each peer that re-advertised a broadcast.
//! When the publisher's relay withdraws it, those routes all derive from the one
//! withdrawn; a relay that selects them in turn re-advertises each stale path, and
//! the cluster walks all of them before it converges (path hunting).

mod support;

use std::{collections::HashMap, time::Duration};

use tokio::{sync::mpsc, time::Instant};

use moq_net::{Hop, Version, announce, broadcast, origin};
use support::harness::{MockPair, peer, peer_with_latency};

fn produce_origin(hop: u64) -> origin::Producer {
	let (producer, driver) = origin::Producer::new(origin::Config::new(Hop::new(hop).unwrap()));
	tokio::spawn(support::harness::run(driver));
	producer
}

/// One update a watcher saw: its prefix, kind, and when.
type Seen = (String, announce::Kind, Instant);

/// Every update per prefix until the watcher goes quiet for longer than the
/// relays' hold-down. Time is paused, so the timeout fires only once every task
/// is idle and every held route has come due.
async fn drain_timed(watched: &mut mpsc::UnboundedReceiver<Seen>) -> HashMap<String, Vec<(announce::Kind, Instant)>> {
	let mut updates = HashMap::<String, Vec<_>>::new();
	while let Ok(Some((prefix, kind, at))) = tokio::time::timeout(Duration::from_secs(5), watched.recv()).await {
		updates.entry(prefix).or_default().push((kind, at));
	}
	updates
}

/// [`drain_timed`] without the timestamps.
async fn drain(watched: &mut mpsc::UnboundedReceiver<Seen>) -> HashMap<String, Vec<announce::Kind>> {
	drain_timed(watched)
		.await
		.into_iter()
		.map(|(prefix, seen)| (prefix, seen.into_iter().map(|(kind, _)| kind).collect()))
		.collect()
}

/// Watch `announced` from its own task, the way a session's announce writer does:
/// it runs when woken, between the relays' own tasks, rather than only once the
/// test task is polled again, which would coalesce every intermediate update.
fn watch(mut announced: announce::Consumer) -> mpsc::UnboundedReceiver<Seen> {
	let (tx, rx) = mpsc::unbounded_channel();
	tokio::spawn(async move {
		while let Some(update) = announced.next().await {
			if tx
				.send((update.prefix.to_string(), update.kind, Instant::now()))
				.is_err()
			{
				break;
			}
		}
	});
	rx
}

/// `n` relays meshed over `edges`, watched from the last one.
struct Mesh {
	nodes: Vec<origin::Producer>,
	_pairs: Vec<MockPair>,
	watched: mpsc::UnboundedReceiver<Seen>,
}

impl Mesh {
	async fn new(version: &str, n: u64, edges: &[(usize, usize)]) -> Self {
		let version: Version = version.parse().unwrap();
		let nodes: Vec<_> = (1..=n).map(produce_origin).collect();
		let mut pairs = Vec::new();
		for &(a, b) in edges {
			pairs.push(peer(version, &nodes[a], &nodes[b]).await);
		}
		let watched = watch(nodes.last().unwrap().consume().announced());
		Self {
			nodes,
			_pairs: pairs,
			watched,
		}
	}

	/// Publish `count` broadcasts spread over every relay but the watcher, starting
	/// at relay `offset`, and require the watcher to see each announced.
	async fn publish(&mut self, count: usize, offset: usize) -> Vec<broadcast::Producer> {
		let relays = self.nodes.len() - 1;
		let broadcasts = (0..count)
			.map(|i| {
				let broadcast = self.nodes[(i + offset) % relays]
					.create_broadcast(format!("room/{i}"))
					.unwrap();
				broadcast.announce(Default::default()).unwrap();
				broadcast
			})
			.collect();
		let updates = drain(&mut self.watched).await;
		assert_eq!(updates.len(), count);
		for (prefix, kinds) in updates {
			assert_eq!(kinds[0], announce::Kind::Announced, "{prefix}: {kinds:?}");
			assert!(kinds.last().unwrap().is_active(), "{prefix}: {kinds:?}");
		}
		broadcasts
	}
}

fn full_mesh(n: usize) -> Vec<(usize, usize)> {
	(0..n).flat_map(|a| (a + 1..n).map(move |b| (a, b))).collect()
}

/// A ring with chords: most relays reach a publisher's relay only through others.
fn ring_with_chords(n: usize) -> Vec<(usize, usize)> {
	(0..n).flat_map(|a| [(a, (a + 1) % n), (a, (a + 3) % n)]).collect()
}

/// Every relay neighbors the publisher's, so each hears the withdrawal first-hand
/// and drops every path derived from it at once. Lite04 names the peer only in
/// the chain, later versions in the announce handshake too.
#[tokio::test(start_paused = true)]
async fn full_mesh_withdraw_retracts_once_lite04() {
	full_mesh_withdraw_retracts_once("moq-lite-04").await;
}

#[tokio::test(start_paused = true)]
async fn full_mesh_withdraw_retracts_once_lite06() {
	full_mesh_withdraw_retracts_once("moq-lite-06").await;
}

async fn full_mesh_withdraw_retracts_once(version: &str) {
	let mut mesh = Mesh::new(version, 8, &full_mesh(8)).await;
	let broadcasts = mesh.publish(100, 0).await;
	drop(broadcasts);
	let updates = drain(&mut mesh.watched).await;
	assert_eq!(updates.len(), 100);
	for (prefix, kinds) in updates {
		assert_eq!(kinds, [announce::Kind::Retracted], "{prefix}");
	}
	// The same relays publish again, clearing their own withdrawals.
	let _broadcasts = mesh.publish(100, 0).await;
}

/// A relay two hops from the publisher's hears only that its neighbor withdrew, not
/// why, so it can still pass through a stale path or two. Every broadcast must still
/// end retracted, and republishing from other relays must reach the watcher again:
/// no withdrawal outlives the peer announcing the path again.
#[tokio::test(start_paused = true)]
async fn partial_mesh_withdraw_then_republish() {
	let mut mesh = Mesh::new("moq-lite-06", 12, &ring_with_chords(12)).await;
	let broadcasts = mesh.publish(100, 0).await;
	drop(broadcasts);
	let updates = drain(&mut mesh.watched).await;
	assert_eq!(updates.len(), 100);
	for (prefix, kinds) in updates {
		assert!(!kinds.last().unwrap().is_active(), "{prefix}: {kinds:?}");
	}
	let _broadcasts = mesh.publish(100, 5).await;
}

/// moq.pro's live mesh on 2026-09-30: 34 relays, numbered by name from
/// `edge0.atl0` (0) to `edge2.sjc0` (33), peered with the relays in neighboring
/// PoPs. Each link carries its one-way latency in milliseconds, estimated from
/// the distance between its PoPs at 100 km/ms.
#[rustfmt::skip]
const LIVE: &[(usize, usize, u64)] = &[
	(0, 20, 12), (0, 22, 9), (0, 29, 9), (1, 3, 66), (1, 12, 39), (1, 14, 67), (1, 21, 66),
	(2, 20, 11), (2, 26, 16), (2, 32, 16), (3, 8, 5), (3, 11, 4), (3, 15, 6), (3, 16, 9),
	(3, 17, 3), (3, 18, 4), (3, 21, 1), (3, 22, 66), (3, 23, 6), (3, 24, 4), (3, 29, 66),
	(3, 30, 6), (3, 31, 4), (4, 7, 66), (4, 20, 82), (4, 22, 76), (4, 25, 66), (4, 29, 76),
	(5, 20, 20), (5, 27, 5), (5, 33, 5), (6, 23, 13), (6, 24, 13), (6, 30, 13), (6, 31, 13),
	(7, 22, 15), (7, 25, 1), (7, 29, 15), (8, 15, 6), (8, 17, 2), (8, 21, 5), (8, 23, 10),
	(8, 30, 10), (9, 19, 5), (9, 22, 4), (9, 23, 56), (9, 28, 5), (9, 29, 4), (9, 30, 56),
	(10, 19, 12), (10, 20, 13), (10, 22, 9), (10, 23, 64), (10, 26, 28), (10, 27, 30), (10, 28, 12),
	(10, 29, 9), (10, 30, 64), (10, 32, 28), (10, 33, 30), (11, 15, 3), (11, 16, 5), (11, 21, 4),
	(12, 14, 53), (12, 27, 136), (12, 33, 136), (13, 14, 78), (13, 27, 120), (13, 33, 120),
	(14, 26, 77), (14, 27, 83), (14, 32, 77), (14, 33, 83), (15, 21, 6), (16, 18, 11), (16, 21, 9),
	(17, 21, 3), (17, 24, 5), (17, 31, 5), (18, 21, 4), (18, 22, 62), (18, 23, 4), (18, 24, 2),
	(18, 29, 62), (18, 30, 4), (18, 31, 2), (19, 22, 8), (19, 23, 53), (19, 26, 37), (19, 28, 1),
	(19, 29, 8), (19, 30, 53), (19, 32, 37), (20, 22, 19), (20, 26, 27), (20, 27, 24), (20, 29, 19),
	(20, 32, 27), (20, 33, 24), (21, 22, 66), (21, 23, 6), (21, 24, 4), (21, 29, 66), (21, 30, 6),
	(21, 31, 4), (22, 23, 59), (22, 24, 62), (22, 25, 15), (22, 26, 37), (22, 27, 39), (22, 28, 8),
	(22, 29, 1), (22, 30, 59), (22, 31, 62), (22, 32, 37), (22, 33, 39), (23, 24, 2), (23, 28, 53),
	(23, 29, 59), (23, 30, 1), (23, 31, 2), (24, 29, 62), (24, 30, 2), (24, 31, 1), (25, 29, 15),
	(26, 27, 11), (26, 28, 37), (26, 29, 37), (26, 32, 1), (26, 33, 11), (27, 29, 39), (27, 32, 11),
	(27, 33, 1), (28, 29, 8), (28, 30, 53), (28, 32, 37), (29, 30, 59), (29, 31, 62), (29, 32, 37),
	(29, 33, 39), (30, 31, 2), (32, 33, 11),
];

/// The live mesh over lite-06, every relay watched.
struct Live {
	nodes: Vec<origin::Producer>,
	/// One per [`LIVE`] link; `None` once the link failed.
	links: Vec<Option<MockPair>>,
	watched: Vec<mpsc::UnboundedReceiver<Seen>>,
}

impl Live {
	/// `latency` scales each link's estimated latency: 0 for none, 1 for the estimate.
	async fn new(latency: u32) -> Self {
		let version: Version = "moq-lite-06".parse().unwrap();
		let nodes: Vec<_> = (1..=34).map(produce_origin).collect();
		let mut links = Vec::new();
		for &(a, b, ms) in LIVE {
			let latency = Duration::from_millis(ms) * latency;
			links.push(Some(peer_with_latency(version, &nodes[a], &nodes[b], latency).await));
		}
		let watched = nodes.iter().map(|node| watch(node.consume().announced())).collect();
		Self { nodes, links, watched }
	}

	/// Publish `name` from relay `publisher` and require every relay to see it.
	async fn publish(&mut self, publisher: usize, name: &str) -> broadcast::Producer {
		let broadcast = self.nodes[publisher].create_broadcast(name).unwrap();
		broadcast.announce(Default::default()).unwrap();
		for (relay, updates) in self.drain().await.into_iter().enumerate() {
			let kinds = updates.get(name).map(|seen| seen.last().unwrap().0);
			assert!(kinds.is_some_and(|kind| kind.is_active()), "relay {relay}: {updates:?}");
		}
		broadcast
	}

	/// What each relay saw since the last drain.
	async fn drain(&mut self) -> Vec<HashMap<String, Vec<(announce::Kind, Instant)>>> {
		let mut all = Vec::new();
		for watched in &mut self.watched {
			all.push(drain_timed(watched).await);
		}
		all
	}
}

/// One withdrawal on the live mesh retracts everywhere once. A relay two hops
/// from the publisher's hears only that its neighbor withdrew, and switches to
/// another path derived from the same announcement. It must not advertise that
/// path before the withdrawal reaches it too, or its peers resurrect the name and
/// the mesh hunts through every stale path (moq-dev/moq.pro#2116).
async fn live_withdraw_retracts_once(latency: u32) {
	let mut live = Live::new(latency).await;
	for publisher in 0..live.nodes.len() {
		let name = format!("room/{publisher}");
		let broadcast = live.publish(publisher, &name).await;
		drop(broadcast);
		for (relay, updates) in live.drain().await.into_iter().enumerate() {
			// Stepping through the paths a relay already holds is local; announcing
			// the name again, or retracting it more than once, is hunting.
			let kinds: Vec<_> = updates[&name].iter().map(|(kind, _)| *kind).collect();
			let (last, stepped) = kinds.split_last().unwrap();
			assert!(
				*last == announce::Kind::Retracted && stepped.iter().all(|kind| *kind == announce::Kind::Updated),
				"publisher {publisher}, relay {relay}: {kinds:?}"
			);
		}
	}
}

#[tokio::test(start_paused = true)]
async fn live_withdraw_retracts_once_without_latency() {
	live_withdraw_retracts_once(0).await;
}

#[tokio::test(start_paused = true)]
async fn live_withdraw_retracts_once_with_latency() {
	live_withdraw_retracts_once(1).await;
}

/// How long a relay holds a replacement before advertising it to a peer relay.
const HOLD_DOWN: Duration = Duration::from_secs(1);

/// A link failure while the publisher stays live fails over: every relay ends up
/// with the broadcast again. A relay whose path crossed the dead link withdraws
/// it from its peers and re-advertises the replacement once it survives the
/// hold-down, so a relay left with no path at all waits about that long, and no
/// longer: the hold-downs along the mesh run side by side rather than in series.
#[tokio::test(start_paused = true)]
async fn live_link_failure_fails_over() {
	let version: Version = "moq-lite-06".parse().unwrap();
	let mut live = Live::new(1).await;
	let mut worst = Duration::ZERO;
	for publisher in 0..live.nodes.len() {
		let name = format!("room/{publisher}");
		let _broadcast = live.publish(publisher, &name).await;

		// Cut every link of the publisher's relay but its slowest.
		let links: Vec<_> = (0..LIVE.len())
			.filter(|&index| LIVE[index].0 == publisher || LIVE[index].1 == publisher)
			.collect();
		let kept = *links.iter().max_by_key(|&&index| LIVE[index].2).unwrap();
		let cut: Vec<_> = links.into_iter().filter(|&index| index != kept).collect();
		for &index in &cut {
			live.links[index] = None;
		}

		for (relay, updates) in live.drain().await.into_iter().enumerate() {
			let Some(seen) = updates.get(&name) else { continue };
			assert!(
				seen.last().unwrap().0.is_active(),
				"publisher {publisher}, relay {relay}: {seen:?}"
			);
			// Every stretch the relay spent with no path at all.
			let mut gone = None;
			for &(kind, at) in seen {
				match (kind, gone.take()) {
					(announce::Kind::Retracted, _) => gone = Some(at),
					(_, Some(since)) => worst = worst.max(at - since),
					_ => {}
				}
			}
		}

		// Restore the links for the next publisher.
		for &index in &cut {
			let (a, b, ms) = LIVE[index];
			let latency = Duration::from_millis(ms);
			live.links[index] = Some(peer_with_latency(version, &live.nodes[a], &live.nodes[b], latency).await);
		}
		live.drain().await;
	}
	println!("longest a relay went without a path: {worst:?}");
	assert!(worst < 2 * HOLD_DOWN, "a relay went {worst:?} without a path");
}

/// A 34-relay partial mesh: moq.pro's production graph on 2026-09-30, where
/// relays in neighboring PoPs peer and most reach a publisher's relay through
/// others.
#[rustfmt::skip]
const PRODUCTION: &[(usize, usize)] = &[
	(0, 20), (0, 22), (0, 29), (1, 3), (1, 12), (1, 14), (1, 21), (2, 20), (2, 26), (2, 32), (3, 8),
	(3, 11), (3, 15), (3, 16), (3, 17), (3, 18), (3, 21), (3, 22), (3, 23), (3, 24), (3, 29), (3, 30),
	(3, 31), (4, 7), (4, 20), (4, 22), (4, 25), (4, 29), (5, 20), (5, 27), (5, 33), (6, 23), (6, 24),
	(6, 30), (6, 31), (7, 22), (7, 25), (7, 29), (8, 15), (8, 17), (8, 21), (8, 23), (8, 30), (9, 19),
	(9, 22), (9, 23), (9, 28), (9, 29), (9, 30), (10, 19), (10, 20), (10, 22), (10, 23), (10, 26),
	(10, 27), (10, 28), (10, 29), (10, 30), (10, 32), (10, 33), (11, 15), (11, 16), (11, 21),
	(12, 14), (12, 27), (12, 33), (13, 14), (13, 27), (13, 33), (14, 26), (14, 27), (14, 32),
	(14, 33), (15, 21), (16, 18), (16, 21), (17, 21), (17, 24), (17, 31), (18, 21), (18, 22),
	(18, 23), (18, 24), (18, 29), (18, 30), (18, 31), (19, 22), (19, 23), (19, 26), (19, 28),
	(19, 29), (19, 30), (19, 32), (20, 22), (20, 26), (20, 27), (20, 29), (20, 32), (20, 33),
	(21, 22), (21, 23), (21, 24), (21, 29), (21, 30), (21, 31), (22, 23), (22, 24), (22, 25),
	(22, 26), (22, 27), (22, 28), (22, 29), (22, 30), (22, 31), (22, 32), (22, 33), (23, 24),
	(23, 28), (23, 29), (23, 30), (23, 31), (24, 29), (24, 30), (24, 31), (25, 29), (26, 27),
	(26, 28), (26, 29), (26, 32), (26, 33), (27, 29), (27, 32), (27, 33), (28, 29), (28, 30),
	(28, 32), (29, 30), (29, 31), (29, 32), (29, 33), (30, 31), (32, 33),
];

/// One-way latency in ms for each [`PRODUCTION`] link, from the great-circle
/// distance between its PoPs at 200 km/ms over a path 1.5 times as long, plus 1 ms.
#[rustfmt::skip]
const PRODUCTION_LATENCY_MS: &[u64] = &[
	10, 7, 7, 50, 30, 51, 50, 9, 13, 13, 5, 4, 6, 8, 3, 4, 1, 50, 6, 4, 50, 6, 4, 50, 63, 58, 50, 58,
	16, 5, 5, 10, 10, 10, 10, 12, 1, 12, 6, 3, 5, 8, 8, 5, 4, 43, 5, 4, 43, 6, 11, 8, 49, 22, 23, 6,
	8, 49, 22, 23, 3, 5, 4, 41, 103, 103, 60, 91, 91, 59, 64, 59, 64, 6, 9, 8, 3, 6, 6, 4, 48, 4, 3,
	48, 4, 3, 5, 44, 26, 1, 5, 44, 26, 15, 21, 18, 15, 21, 18, 50, 6, 4, 50, 6, 4, 45, 47, 12, 29, 30,
	5, 1, 45, 47, 29, 30, 2, 44, 45, 1, 2, 47, 2, 1, 12, 9, 26, 29, 1, 9, 30, 9, 1, 5, 44, 26, 45, 47,
	29, 30, 2, 9,
];

/// One withdrawal on a partial mesh retracts everywhere once. A relay two hops
/// from the publisher's hears only that its neighbor withdrew, and must not
/// fall back to, and re-advertise, another path derived from the same
/// announcement. Holding route updates (`origin::Config::update_hold`) lets the
/// withdrawal remove those paths first; with link latency and no hold, each
/// withdrawal here costs tens of thousands of announcements.
#[tokio::test(start_paused = true)]
async fn partial_mesh_withdraw_retracts_once() {
	let version: Version = "moq-lite-06".parse().unwrap();
	let nodes: Vec<_> = (1..=34).map(produce_origin).collect();
	let mut pairs = Vec::new();
	for (&(a, b), &ms) in PRODUCTION.iter().zip(PRODUCTION_LATENCY_MS) {
		pairs.push(peer_with_latency(version, &nodes[a], &nodes[b], Duration::from_millis(ms)).await);
	}
	let mut watched: Vec<_> = nodes.iter().map(|node| watch(node.consume().announced())).collect();

	for publisher in [5, 13, 22, 26, 32] {
		let broadcast = nodes[publisher].create_broadcast(format!("room/{publisher}")).unwrap();
		broadcast.announce(Default::default()).unwrap();
		for (relay, watched) in watched.iter_mut().enumerate() {
			let updates = drain(watched).await;
			assert!(
				updates.values().all(|kinds| kinds.last().unwrap().is_active()),
				"relay {relay}: {updates:?}"
			);
		}

		drop(broadcast);
		let mut hunted = Vec::new();
		for (relay, watched) in watched.iter_mut().enumerate() {
			let updates = drain(watched).await;
			let kinds = &updates[&format!("room/{publisher}")];
			if kinds != &[announce::Kind::Retracted] {
				hunted.push((relay, kinds.clone()));
			}
		}
		assert!(hunted.is_empty(), "publisher {publisher}: {hunted:?}");
	}
}
