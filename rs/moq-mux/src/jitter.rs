//! A jitter buffer that releases several tracks' frames in one decode order, each a fixed
//! delay after its decode time.

use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use moq_net::Timestamp;
use web_async::time::{Instant, Sleep};

/// A frame handed to [`Buffer::push`].
pub(crate) struct Arrival<T> {
	/// When the frame was read from its source.
	pub arrived: Instant,
	/// When the frame decodes, nondecreasing within a track.
	pub decode: Timestamp,
	/// How many times the source had restarted its timeline when the frame was read.
	pub restart: u64,
	/// How many times the source's playhead had jumped (a skipped group, or a restart)
	/// when the frame was read.
	pub skip: u64,
	/// Whether the frame decodes without the track's earlier frames.
	pub sync: bool,
	pub item: T,
}

/// A frame [`Buffer::poll_next`] let go.
pub(crate) struct Ready<K, T> {
	pub track: K,
	/// Counts up each time a restart moved the timeline, and the clock with it. Every
	/// frame of one generation goes out before any frame of the next.
	pub generation: u64,
	pub item: T,
}

/// What [`Buffer::push`] did with a frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Push {
	Queued,
	/// It missed its deadline and was dropped; the track resumes at its next sync frame.
	Late,
	/// It was dropped because the track is waiting for a sync frame.
	Waiting,
}

/// Holds each track's frames until a fixed delay past their decode time, like an SRT
/// receiver's TSBPD, in decode order across tracks.
///
/// Every track runs on one clock, anchored at the first frame's arrival. Under it the
/// deadline order is the decode order, so two buffers that saw the same frames arrive with
/// different skew, each within its deadline, emit them in the same order. A frame that
/// arrives past its deadline would break that order, so it is dropped and counted.
///
/// A skipped group leaves the timeline where it was, so it keeps the clock: frames it made
/// late are dropped like any other. A source that restarts its timeline (a declared
/// marker) has moved it, so once frames have gone out the restart opens a new generation
/// with its own clock, anchored at that frame though never ahead of a deadline already
/// given out. So does a skip after which a frame would be held more than a delay past
/// everything queued: its timeline jumped ahead, as when the skipped groups held a marker
/// the publisher shed. Every track's next frame runs on it: one crossing the same restart joins it
/// when the frame lands on its clock, neither late nor held more than a delay past
/// everything queued, and opens another otherwise. Before anything has gone out there is
/// nothing to keep in step with, so a restart there keeps the clock. No two tracks are
/// ever on different clocks.
///
/// The clock follows the source's: a source clock running slower than ours would make
/// every frame late in the end, and a faster one would hold more and more. So the clock
/// measures how far the source's runs off ours from the least slack frames arrive with, runs
/// its decode timeline at that rate, and pulls the least slack back to the delay, which also
/// wears away a lead the first frame anchored it with. The decode timeline is the output's
/// system clock, so it keeps to what ISO/IEC 13818-1 2.4.2.1 allows one: within [`MAX_DRIFT`]
/// of ours, changing by at most [`MAX_SLEW`]. A source past that falls behind or piles up
/// until it has used half the delay, and then [`Buffer::push`] fails.
///
/// A zero delay holds nothing and drops nothing: each frame goes out as soon as it is
/// read, ordered only among the frames read together.
pub(crate) struct Buffer<K, T> {
	delay: Duration,
	/// The clock every frame is pushed under.
	clock: Option<Clock>,
	tracks: BTreeMap<K, Track<T>>,
	/// The latest deadline given out.
	horizon: Option<Instant>,
	/// Whether a frame has gone out since the clock started.
	released: bool,
	/// What the clock is steered on, since it last started.
	steer: Steer,
	timer: Option<Pin<Box<Sleep>>>,
	dropped: u64,
}

/// How often the clock is steered, in decode time: long enough that the least slack covers
/// a group's worth of frames sent ahead by different amounts.
const STEER: Duration = Duration::from_secs(2);
/// How far back the source's rate is measured, in decode time: long enough that arrival
/// jitter averages out of it.
const RATE_WINDOW: f64 = 600.0;
/// How quickly the clock pulls the least slack back to the delay: it closes the gap over this
/// many seconds, or slower where the slew limit could not stop it in time.
const RESPONSE: f64 = 600.0;
/// The furthest the clock runs off ours: 810 Hz of the 27 MHz system clock (ISO/IEC 13818-1
/// 2.4.2.1).
const MAX_DRIFT: f64 = 810.0 / 27e6;
/// How fast that may change, per second: 0.075 Hz/s of 27 MHz (ISO/IEC 13818-1 2.4.2.1).
const MAX_SLEW: f64 = 0.075 / 27e6;

/// The decode timeline's mapping onto ours: where a frame decoding at `base` is due, less the
/// delay, and how much longer than the decode timeline ours runs.
#[derive(Clone, Copy)]
struct Clock {
	generation: u64,
	anchor: Instant,
	base: Timestamp,
	/// As a fraction of the decode timeline.
	drift: f64,
}

/// What the clock is steered on.
#[derive(Default)]
struct Steer {
	/// The least slack (deadline less arrival, in seconds) a frame arrived with since the last
	/// step, and the decode time the step began at.
	least: Option<(f64, Timestamp)>,
	/// Each step's decode time and the source's phase there, in seconds, over the last
	/// [`RATE_WINDOW`]: how far the least slack is past the delay, less how far the drift has
	/// moved the deadlines. Its slope is how much slower the source's clock runs than ours.
	phase: VecDeque<(f64, f64)>,
	/// How far the drift has moved the deadlines, in seconds.
	steered: f64,
}

struct Track<T> {
	/// Frames in arrival order, each with its generation and deadline.
	queue: VecDeque<(u64, Instant, T)>,
	/// The source's restart and skip counters at the last frame.
	restart: u64,
	skip: u64,
	/// The generation of the last frame.
	generation: u64,
	/// A frame was dropped, so later ones are too until the next sync frame.
	waiting: bool,
}

impl<K: Ord + Clone, T> Buffer<K, T> {
	pub fn new(delay: Duration) -> Self {
		Self {
			delay,
			clock: None,
			tracks: BTreeMap::new(),
			horizon: None,
			released: false,
			steer: Steer::default(),
			timer: None,
			dropped: 0,
		}
	}

	/// Queue a frame, or drop it if it cannot make its deadline. Fails once the source's clock
	/// runs further off ours than the clock may follow.
	pub fn push(&mut self, key: K, arrival: Arrival<T>) -> anyhow::Result<Push> {
		let clock = *self.clock.get_or_insert(Clock {
			generation: 0,
			anchor: arrival.arrived,
			base: arrival.decode,
			drift: 0.0,
		});
		let mut generation = clock.generation;
		let mut deadline = self.deadline(&clock, arrival.decode);
		// A track still on an older generation may be crossing the restart another track
		// opened the newest one for.
		let jumped = self.tracks.get(&key).is_some_and(|track| {
			let restarted = track.restart != arrival.restart
				&& (track.generation == generation || !self.lands(deadline, arrival.arrived));
			let leapt =
				track.skip != arrival.skip && deadline.is_some_and(|deadline| deadline > self.bound(arrival.arrived));
			restarted || leapt
		});
		if jumped && self.released {
			generation += 1;
			let after = self.horizon.and_then(|horizon| horizon.checked_sub(self.delay));
			let clock = Clock {
				generation,
				anchor: after.map_or(arrival.arrived, |after| after.max(arrival.arrived)),
				base: arrival.decode,
				drift: clock.drift,
			};
			self.clock = Some(clock);
			self.steer = Steer::default();
			deadline = self.deadline(&clock, arrival.decode);
		} else if self.released && !self.delay.is_zero() {
			self.steer(deadline, &arrival)?;
		}

		let track = self.tracks.entry(key).or_insert_with(|| Track {
			queue: VecDeque::new(),
			restart: arrival.restart,
			skip: arrival.skip,
			generation,
			waiting: false,
		});
		track.restart = arrival.restart;
		track.skip = arrival.skip;
		track.generation = generation;
		let push = match deadline {
			_ if track.waiting && !arrival.sync => Push::Waiting,
			Some(deadline) if arrival.arrived <= deadline || self.delay.is_zero() => {
				track.waiting = false;
				track.queue.push_back((generation, deadline, arrival.item));
				self.horizon = self.horizon.max(Some(deadline));
				Push::Queued
			}
			// Past the deadline, or so far off the clock that no instant holds it.
			_ => {
				track.waiting = true;
				Push::Late
			}
		};
		if push != Push::Queued {
			self.dropped += 1;
		}
		Ok(push)
	}

	/// Whether a frame arriving at `arrived` and due at `deadline` is on the clock: not late,
	/// and held no more than a delay past both its arrival and everything already queued.
	fn lands(&self, deadline: Option<Instant>, arrived: Instant) -> bool {
		deadline.is_some_and(|deadline| arrived <= deadline && deadline <= self.bound(arrived))
	}

	/// The latest a frame arriving at `arrived` may be due and still be on the clock: a delay
	/// past both its arrival and everything already queued.
	fn bound(&self, arrived: Instant) -> Instant {
		arrived.max(self.horizon.unwrap_or(arrived)) + self.delay
	}

	/// Account for the slack a frame arrived with, and every [`STEER`] of decode time step the
	/// clock's drift toward the source's rate plus a pull back to the delay, as far as
	/// [`MAX_SLEW`] allows.
	fn steer(&mut self, deadline: Option<Instant>, arrival: &Arrival<T>) -> anyhow::Result<()> {
		let (Some(clock), Some(deadline)) = (self.clock, deadline) else {
			return Ok(());
		};
		let slack = match deadline >= arrival.arrived {
			true => (deadline - arrival.arrived).as_secs_f64(),
			false => -(arrival.arrived - deadline).as_secs_f64(),
		};
		let (least, since) = self.steer.least.get_or_insert((slack, arrival.decode));
		*least = least.min(slack);
		if arrival.decode.as_nanos().saturating_sub(since.as_nanos()) < STEER.as_nanos() {
			return Ok(());
		}
		// Re-anchor where this frame decodes, so the new drift starts from there.
		let Some(anchor) = deadline.checked_sub(self.delay) else {
			return Ok(());
		};
		let delay = self.delay.as_secs_f64();
		let gap = *least - delay;
		self.steer.least = None;

		let now = arrival.decode.as_nanos() as f64 / 1e9;
		let elapsed = now - clock.base.as_nanos() as f64 / 1e9;
		self.steer.steered += elapsed * clock.drift;
		let phase = &mut self.steer.phase;
		phase.push_back((now, gap - self.steer.steered));
		while phase.front().is_some_and(|&(at, _)| now - at > RATE_WINDOW) {
			phase.pop_front();
		}
		let source = -slope(phase).unwrap_or(-clock.drift);

		// Pull the gap shut over [`RESPONSE`], no faster than the slew limit can stop on it.
		let pull = (gap.abs() / RESPONSE).min((2.0 * MAX_SLEW * gap.abs()).sqrt());
		let target = source - pull.copysign(gap);
		// Tracks interleave a little off decode order, so a step may decode before the last.
		let step = MAX_SLEW * elapsed.max(0.0);
		let drift = (clock.drift + (target - clock.drift).clamp(-step, step)).clamp(-MAX_DRIFT, MAX_DRIFT);
		self.clock = Some(Clock {
			anchor,
			base: arrival.decode,
			drift,
			..clock
		});

		// At the limit and still losing ground, with half the delay gone.
		if drift == MAX_DRIFT.copysign(source) && source.abs() > MAX_DRIFT && gap * source.signum() < -delay / 2.0 {
			anyhow::bail!(
				"the source's clock runs {:.1} ppm off ours, past the {:.0} ppm the output's may follow",
				source * 1e6,
				MAX_DRIFT * 1e6
			);
		}
		Ok(())
	}

	/// When a frame decoding at `decode` goes out on the current clock, once there is one.
	pub fn at(&self, decode: Timestamp) -> Option<Instant> {
		self.deadline(self.clock.as_ref()?, decode)
	}

	/// When a frame decoding at `decode` goes out on `clock`, if any instant holds it.
	fn deadline(&self, clock: &Clock, decode: Timestamp) -> Option<Instant> {
		// Signed, since a frame can decode before the one that anchored the clock.
		let since = decode.as_nanos() as i128 - clock.base.as_nanos() as i128;
		let offset = since + (since as f64 * clock.drift) as i128 + self.delay.as_nanos() as i128;
		let nanos = u64::try_from(offset.unsigned_abs()).ok()?;
		match offset >= 0 {
			true => clock.anchor.checked_add(Duration::from_nanos(nanos)),
			false => clock.anchor.checked_sub(Duration::from_nanos(nanos)),
		}
	}

	/// The generation, deadline and track of the frame that goes out next: generation by
	/// generation, earliest deadline first, ties by track.
	fn front(&self) -> Option<(u64, Instant, &K)> {
		self.tracks
			.iter()
			.filter_map(|(key, track)| {
				let (generation, deadline, _) = track.queue.front()?;
				Some((*generation, *deadline, key))
			})
			.min()
	}

	/// The next frame whose deadline has come, in [`Self::front`] order.
	pub fn poll_next(&mut self, waiter: &kio::Waiter) -> Poll<Ready<K, T>> {
		let Some((_, deadline, key)) = self.front() else {
			self.timer = None;
			return Poll::Pending;
		};
		let key = key.clone();
		if !self.delay.is_zero() && Instant::now() < deadline {
			let timer = self
				.timer
				.get_or_insert_with(|| Box::pin(web_async::time::sleep_until(deadline)));
			if timer.deadline() != deadline {
				timer.as_mut().reset(deadline);
			}
			if waiter.poll_future(timer.as_mut()).is_pending() {
				return Poll::Pending;
			}
		}
		let (generation, _, item) = self.tracks.get_mut(&key).and_then(|t| t.queue.pop_front()).unwrap();
		self.released = true;
		Poll::Ready(Ready {
			track: key,
			generation,
			item,
		})
	}

	/// When the next queued frame is due.
	#[cfg(test)]
	pub fn next_deadline(&self) -> Option<Instant> {
		self.front().map(|(_, deadline, _)| deadline)
	}

	/// Whether no frame is waiting.
	pub fn is_empty(&self) -> bool {
		self.tracks.values().all(|track| track.queue.is_empty())
	}

	/// How many frames were dropped, late or waiting for a sync frame.
	pub fn dropped(&self) -> u64 {
		self.dropped
	}

	/// Drop every queued frame and the clock, so the next frame starts it afresh.
	pub fn clear(&mut self) {
		self.clock = None;
		self.tracks.clear();
		self.horizon = None;
		self.released = false;
		self.steer = Steer::default();
		self.timer = None;
	}
}

/// The least-squares slope of `points`, if they span any time.
fn slope(points: &VecDeque<(f64, f64)>) -> Option<f64> {
	let n = points.len() as f64;
	let (x, y) = points
		.iter()
		.fold((0.0, 0.0), |(x, y), (px, py)| (x + px / n, y + py / n));
	let (cov, var) = points.iter().fold((0.0, 0.0), |(cov, var), (px, py)| {
		(cov + (px - x) * (py - y), var + (px - x).powi(2))
	});
	(var > 0.0).then(|| cov / var)
}

#[cfg(test)]
mod tests {
	use super::*;

	const DELAY: Duration = Duration::from_millis(100);

	fn ms(ms: u64) -> Timestamp {
		Timestamp::from_millis(ms).unwrap()
	}

	fn arrival(arrived: Instant, decode: u64, item: &'static str) -> Arrival<&'static str> {
		Arrival {
			arrived,
			decode: ms(decode),
			restart: 0,
			skip: 0,
			sync: true,
			item,
		}
	}

	/// The same frame, read after its source restarted its timeline `restart` times.
	fn after(restart: u64, arrival: Arrival<&'static str>) -> Arrival<&'static str> {
		Arrival {
			restart,
			skip: restart,
			..arrival
		}
	}

	/// Every frame due by now, in order, with its generation.
	fn released(buffer: &mut Buffer<u16, &'static str>) -> Vec<(&'static str, u64)> {
		let waiter = kio::Waiter::noop();
		let mut out = Vec::new();
		while let Poll::Ready(ready) = buffer.poll_next(&waiter) {
			out.push((ready.item, ready.generation));
		}
		out
	}

	/// Every frame due by now, in order.
	fn due(buffer: &mut Buffer<u16, &'static str>) -> Vec<&'static str> {
		released(buffer).into_iter().map(|(item, _)| item).collect()
	}

	#[tokio::test(start_paused = true)]
	async fn releases_at_the_delay_in_decode_order() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		assert_eq!(buffer.push(1, arrival(start, 0, "v0")).unwrap(), Push::Queued);
		assert_eq!(buffer.push(1, arrival(start, 40, "v40")).unwrap(), Push::Queued);
		// Audio arrives later than the video, with an earlier decode time.
		assert_eq!(
			buffer
				.push(2, arrival(start + Duration::from_millis(30), 20, "a20"))
				.unwrap(),
			Push::Queued
		);
		assert_eq!(
			buffer
				.push(2, arrival(start + Duration::from_millis(30), 40, "a40"))
				.unwrap(),
			Push::Queued
		);

		assert!(due(&mut buffer).is_empty(), "nothing is due before the delay");
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["v0"]);
		tokio::time::advance(Duration::from_millis(20)).await;
		assert_eq!(due(&mut buffer), ["a20"]);
		tokio::time::advance(Duration::from_millis(20)).await;
		assert_eq!(due(&mut buffer), ["v40", "a40"], "a tie goes to the lower track");
		assert!(buffer.is_empty());
	}

	/// Two buffers fed the same frames with different arrival skew, every frame inside
	/// its deadline, emit the same order.
	#[tokio::test(start_paused = true)]
	async fn arrival_skew_does_not_change_the_order() {
		let start = Instant::now();
		let (mut early, mut late) = (Buffer::new(DELAY), Buffer::new(DELAY));
		let frames = [
			(1, 0, "v0"),
			(1, 40, "v40"),
			(1, 80, "v80"),
			(2, 0, "a0"),
			(2, 20, "a20"),
			(2, 60, "a60"),
		];
		for (key, decode, item) in frames {
			// One sees audio lag by 90ms, the other sees every frame on time.
			let skew = if key == 2 { 90 } else { 0 };
			assert_eq!(
				early
					.push(key, arrival(start + Duration::from_millis(decode), decode, item))
					.unwrap(),
				Push::Queued
			);
			let arrived = start + Duration::from_millis(decode + skew);
			assert_eq!(late.push(key, arrival(arrived, decode, item)).unwrap(), Push::Queued);
		}
		tokio::time::advance(Duration::from_secs(1)).await;
		let order = due(&mut early);
		assert_eq!(order, ["v0", "a0", "a20", "v40", "a60", "v80"]);
		assert_eq!(due(&mut late), order);
	}

	/// A late frame is dropped and counted, and the rest keep their order. A track that
	/// dropped a frame waits for its next sync frame.
	#[tokio::test(start_paused = true)]
	async fn late_frames_are_dropped_until_a_sync_frame() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "v0")).unwrap();
		buffer.push(2, arrival(start, 0, "a0")).unwrap();
		let late = start + Duration::from_millis(200);
		let video = |decode, sync, item| Arrival {
			sync,
			..arrival(late, decode, item)
		};
		assert_eq!(buffer.push(1, video(40, false, "v40")).unwrap(), Push::Late);
		assert_eq!(buffer.push(1, video(200, false, "v200")).unwrap(), Push::Waiting);
		assert_eq!(buffer.push(1, video(240, true, "v240")).unwrap(), Push::Queued);
		assert_eq!(buffer.push(2, arrival(late, 180, "a180")).unwrap(), Push::Queued);
		assert_eq!(buffer.dropped(), 2);

		tokio::time::advance(Duration::from_secs(1)).await;
		assert_eq!(due(&mut buffer), ["v0", "a0", "a180", "v240"]);
	}

	/// A restart before anything went out keeps the clock, so the tracks stay on one.
	#[tokio::test(start_paused = true)]
	async fn a_skip_before_the_first_release_keeps_one_clock() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		// The video's first group is stale and anchors the clock; the audio is live.
		buffer.push(1, arrival(start, 0, "v0")).unwrap();
		buffer.push(2, arrival(start, 900, "a900")).unwrap();
		// The video consumer skips to the live group.
		let skip = start + Duration::from_millis(5);
		assert_eq!(
			buffer.push(1, after(1, arrival(skip, 900, "v900"))).unwrap(),
			Push::Queued
		);
		assert_eq!(
			buffer.push(1, after(1, arrival(skip, 940, "v940"))).unwrap(),
			Push::Queued
		);
		assert_eq!(buffer.push(2, arrival(skip, 940, "a940")).unwrap(), Push::Queued);

		tokio::time::advance(Duration::from_secs(2)).await;
		assert_eq!(
			released(&mut buffer),
			[("v0", 0), ("v900", 0), ("a900", 0), ("v940", 0), ("a940", 0)]
		);
	}

	/// A restart after frames went out opens a new generation, and every track's next frame
	/// runs on it, whether or not that track saw the restart.
	#[tokio::test(start_paused = true)]
	async fn every_track_joins_a_new_generation_at_its_next_frame() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "v0")).unwrap();
		buffer.push(2, arrival(start, 0, "a0")).unwrap();
		buffer.push(3, arrival(start, 0, "d0")).unwrap();
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["v0", "a0", "d0"]);

		// The publisher resumes a second later with its timeline five seconds on.
		let resume = start + Duration::from_secs(1);
		tokio::time::advance(resume - Instant::now()).await;
		assert_eq!(
			buffer.push(1, after(1, arrival(resume, 5_000, "v5000"))).unwrap(),
			Push::Queued
		);
		// The audio crosses no restart of its own; the data crosses the same one.
		let late = resume + Duration::from_millis(10);
		assert_eq!(buffer.push(2, arrival(late, 5_000, "a5000")).unwrap(), Push::Queued);
		assert_eq!(
			buffer.push(3, after(1, arrival(late, 5_000, "d5000"))).unwrap(),
			Push::Queued
		);
		assert_eq!(buffer.push(2, arrival(late, 5_020, "a5020")).unwrap(), Push::Queued);

		tokio::time::advance(DELAY).await;
		assert_eq!(released(&mut buffer), [("v5000", 1), ("a5000", 1), ("d5000", 1)]);
		tokio::time::advance(Duration::from_millis(20)).await;
		assert_eq!(released(&mut buffer), [("a5020", 1)]);
	}

	/// A skipped group whose timeline carried on keeps the clock: a frame it made late is
	/// dropped, and the next on-time frame goes out on the same generation.
	#[tokio::test(start_paused = true)]
	async fn a_skip_keeps_the_clock() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "a0")).unwrap();
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["a0"]);

		// Group 1 is skipped: frames from 100 ms on arrive after a 250 ms stall.
		let stalled = start + Duration::from_millis(350);
		tokio::time::advance(stalled - Instant::now()).await;
		let skipped = |decode, item| Arrival {
			skip: 1,
			..arrival(stalled, decode, item)
		};
		assert_eq!(buffer.push(1, skipped(200, "a200")).unwrap(), Push::Late);
		assert_eq!(buffer.push(1, skipped(300, "a300")).unwrap(), Push::Queued);
		tokio::time::advance(Duration::from_millis(100)).await;
		assert_eq!(released(&mut buffer), [("a300", 0)]);
	}

	/// A skip after which a frame would be held more than a delay past everything queued
	/// followed a timeline that leapt ahead, as when the skipped groups held a marker the
	/// publisher shed, so it opens a generation.
	#[tokio::test(start_paused = true)]
	async fn a_skip_that_leaps_ahead_opens_a_generation() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "a0")).unwrap();
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["a0"]);

		let now = Instant::now();
		let leapt = Arrival {
			skip: 1,
			..arrival(now, 5_000, "a5000")
		};
		assert_eq!(buffer.push(1, leapt).unwrap(), Push::Queued);
		tokio::time::advance(DELAY).await;
		assert_eq!(released(&mut buffer), [("a5000", 1)]);
	}

	/// Every frame of a generation goes out before the next generation's, even one the new
	/// clock puts earlier.
	#[tokio::test(start_paused = true)]
	async fn generations_go_out_in_turn() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "v0")).unwrap();
		buffer.push(1, arrival(start, 40, "v40")).unwrap();
		buffer.push(2, arrival(start, 20, "a20")).unwrap();
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["v0"]);

		// A backlog across a jump in the timeline, read in one go.
		let now = Instant::now();
		buffer.push(1, after(1, arrival(now, 5_000, "v5000"))).unwrap();
		buffer.push(2, arrival(now, 4_900, "a4900")).unwrap();
		buffer.push(2, arrival(now, 5_020, "a5020")).unwrap();
		tokio::time::advance(Duration::from_secs(1)).await;
		assert_eq!(
			released(&mut buffer),
			[("a20", 0), ("v40", 0), ("a4900", 1), ("v5000", 1), ("a5020", 1)]
		);
	}

	/// Feed `hours` of 5 fps frames from a source whose clock runs `ppm` slower than ours
	/// through a 500 ms buffer, checking the clock stays within what 13818-1 allows, until a
	/// push fails. Returns that error and the most frames the buffer held.
	async fn drift(ppm: i128, hours: u64) -> (Option<anyhow::Error>, usize) {
		let start = Instant::now();
		let mut buffer = Buffer::new(Duration::from_millis(500));
		let mut most = 0;
		let mut last = (0.0, ms(0));
		for k in 0..hours * 3_600 * 5 {
			let decode = Duration::from_millis(k * 200);
			let source = decode.as_nanos() as i128 * (1_000_000 + ppm) / 1_000_000;
			let arrived = start + Duration::from_nanos(source as u64);
			tokio::time::advance(arrived.saturating_duration_since(Instant::now())).await;
			let frame = Arrival {
				arrived,
				decode: Timestamp::from_micros(decode.as_micros() as u64).unwrap(),
				restart: 0,
				skip: 0,
				sync: true,
				item: "v",
			};
			match buffer.push(1, frame) {
				Ok(push) => assert_eq!(push, Push::Queued, "{ppm} ppm: frame {k} was late"),
				Err(err) => return (Some(err), most),
			}
			most = most.max(buffer.tracks[&1].queue.len());
			due(&mut buffer);

			let clock = buffer.clock.unwrap();
			let elapsed = (clock.base.as_nanos() - last.1.as_nanos()) as f64 / 1e9;
			assert!(clock.drift.abs() <= MAX_DRIFT, "{ppm} ppm: drift {}", clock.drift);
			assert!(
				(clock.drift - last.0).abs() <= MAX_SLEW * elapsed * (1.0 + 1e-9),
				"{ppm} ppm: drift slewed from {} to {} in {elapsed} s",
				last.0,
				clock.drift
			);
			last = (clock.drift, clock.base);
		}
		let drift = buffer.clock.unwrap().drift;
		assert!(
			(drift * 1e6 - ppm as f64).abs() < 0.5,
			"{ppm} ppm: the clock settled at {} ppm",
			drift * 1e6
		);
		(None, most)
	}

	/// A source whose clock runs off ours, slower or faster, by up to the 30 ppm 13818-1 allows
	/// neither goes late nor piles up, and the clock settles at its rate.
	#[tokio::test(start_paused = true)]
	async fn the_clock_follows_a_drifting_source() {
		for ppm in [25, -25] {
			let (err, most) = drift(ppm, 10).await;
			assert!(err.is_none(), "{ppm} ppm: {err:?}");
			assert!(most <= 5, "{ppm} ppm: the buffer grew to {most} frames");
		}
	}

	/// A source further off than the clock may follow fails once it has used half the delay,
	/// before any frame goes late.
	#[tokio::test(start_paused = true)]
	async fn a_source_past_the_drift_limit_fails() {
		for ppm in [40, -40] {
			let (err, _) = drift(ppm, 6).await;
			assert!(err.is_some(), "{ppm} ppm: no error");
		}
	}

	/// Zero holds nothing: frames read together go out at once in decode order, and a
	/// frame behind the clock still goes out.
	#[tokio::test(start_paused = true)]
	async fn zero_delay_releases_on_arrival() {
		let start = Instant::now();
		let mut buffer = Buffer::new(Duration::ZERO);
		buffer.push(1, arrival(start, 0, "v0")).unwrap();
		buffer.push(1, arrival(start, 40, "v40")).unwrap();
		buffer.push(2, arrival(start, 20, "a20")).unwrap();
		assert_eq!(due(&mut buffer), ["v0", "a20", "v40"]);

		let late = start + Duration::from_secs(1);
		assert_eq!(buffer.push(2, arrival(late, 40, "a40")).unwrap(), Push::Queued);
		assert_eq!(due(&mut buffer), ["a40"]);
		assert_eq!(buffer.dropped(), 0);
	}

	#[tokio::test(start_paused = true)]
	async fn clear_starts_a_fresh_clock() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 5_000, "old")).unwrap();
		buffer.clear();
		assert!(buffer.is_empty());

		tokio::time::advance(Duration::from_secs(1)).await;
		let now = Instant::now();
		assert_eq!(buffer.push(1, arrival(now, 0, "new")).unwrap(), Push::Queued);
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["new"]);
	}
}
