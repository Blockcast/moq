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
	/// The source's discontinuity counter when the frame was read.
	pub discontinuity: u64,
	/// Whether the frame decodes without the track's earlier frames.
	pub sync: bool,
	pub item: T,
}

/// A frame [`Buffer::poll_next`] let go.
pub(crate) struct Ready<K, T> {
	pub track: K,
	/// Counts up each time a discontinuity moved the timeline, and the clock with it. Every
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
/// A source's discontinuity (a skipped group, a declared marker) may have moved its
/// timeline, so once frames have gone out it opens a new generation with its own clock,
/// anchored at that frame though never ahead of a deadline already given out. Every
/// track's next frame runs on it: one crossing the same discontinuity joins it when the
/// frame lands on its clock, neither late nor held more than a delay past everything
/// queued, and opens another otherwise. Before anything has gone out there is nothing to
/// keep in step with, so a discontinuity there (a consumer skipping a stale group at join)
/// keeps the clock. No two tracks are ever on different clocks.
///
/// A zero delay holds nothing and drops nothing: each frame goes out as soon as it is
/// read, ordered only among the frames read together.
pub(crate) struct Buffer<K, T> {
	delay: Duration,
	/// The clock every frame is pushed under: its generation, and the arrival and decode
	/// time of the frame that anchored it.
	clock: Option<(u64, Instant, Timestamp)>,
	tracks: BTreeMap<K, Track<T>>,
	/// The latest deadline given out.
	horizon: Option<Instant>,
	/// Whether a frame has gone out since the clock started.
	released: bool,
	timer: Option<Pin<Box<Sleep>>>,
	dropped: u64,
}

struct Track<T> {
	/// Frames in arrival order, each with its generation and deadline.
	queue: VecDeque<(u64, Instant, T)>,
	/// The source's discontinuity counter at the last frame.
	discontinuity: u64,
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
			timer: None,
			dropped: 0,
		}
	}

	/// Queue a frame, or drop it if it cannot make its deadline.
	pub fn push(&mut self, key: K, arrival: Arrival<T>) -> Push {
		let (mut generation, anchor, base) = *self.clock.get_or_insert((0, arrival.arrived, arrival.decode));
		let mut deadline = self.deadline(anchor, base, arrival.decode);
		// A track still on an older generation may be crossing the discontinuity another
		// track opened the newest one for.
		let jumped = self.tracks.get(&key).is_some_and(|track| {
			track.discontinuity != arrival.discontinuity
				&& (track.generation == generation || !self.lands(deadline, arrival.arrived))
		});
		if jumped && self.released {
			generation += 1;
			let after = self.horizon.and_then(|horizon| horizon.checked_sub(self.delay));
			let anchor = after.map_or(arrival.arrived, |after| after.max(arrival.arrived));
			self.clock = Some((generation, anchor, arrival.decode));
			deadline = self.deadline(anchor, arrival.decode, arrival.decode);
		}

		let track = self.tracks.entry(key).or_insert_with(|| Track {
			queue: VecDeque::new(),
			discontinuity: arrival.discontinuity,
			generation,
			waiting: false,
		});
		track.discontinuity = arrival.discontinuity;
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
		push
	}

	/// Whether a frame arriving at `arrived` and due at `deadline` is on the clock: not late,
	/// and held no more than a delay past both its arrival and everything already queued.
	fn lands(&self, deadline: Option<Instant>, arrived: Instant) -> bool {
		deadline.is_some_and(|deadline| {
			let bound = arrived.max(self.horizon.unwrap_or(arrived)) + self.delay;
			arrived <= deadline && deadline <= bound
		})
	}

	/// When a frame decoding at `decode` goes out on the current clock, once there is one.
	pub fn at(&self, decode: Timestamp) -> Option<Instant> {
		let (_, anchor, base) = self.clock?;
		self.deadline(anchor, base, decode)
	}

	/// When a frame decoding at `decode` goes out on the clock anchored at `anchor` and
	/// `base`, if any instant holds it.
	fn deadline(&self, anchor: Instant, base: Timestamp, decode: Timestamp) -> Option<Instant> {
		// Signed, since a frame can decode before the one that anchored the clock.
		let offset = decode.as_nanos() as i128 - base.as_nanos() as i128 + self.delay.as_nanos() as i128;
		let nanos = u64::try_from(offset.unsigned_abs()).ok()?;
		match offset >= 0 {
			true => anchor.checked_add(Duration::from_nanos(nanos)),
			false => anchor.checked_sub(Duration::from_nanos(nanos)),
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
		self.timer = None;
	}
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
			discontinuity: 0,
			sync: true,
			item,
		}
	}

	/// The same frame, read after its source's discontinuity counter moved to `discontinuity`.
	fn after(discontinuity: u64, arrival: Arrival<&'static str>) -> Arrival<&'static str> {
		Arrival {
			discontinuity,
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
		assert_eq!(buffer.push(1, arrival(start, 0, "v0")), Push::Queued);
		assert_eq!(buffer.push(1, arrival(start, 40, "v40")), Push::Queued);
		// Audio arrives later than the video, with an earlier decode time.
		assert_eq!(
			buffer.push(2, arrival(start + Duration::from_millis(30), 20, "a20")),
			Push::Queued
		);
		assert_eq!(
			buffer.push(2, arrival(start + Duration::from_millis(30), 40, "a40")),
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
				early.push(key, arrival(start + Duration::from_millis(decode), decode, item)),
				Push::Queued
			);
			let arrived = start + Duration::from_millis(decode + skew);
			assert_eq!(late.push(key, arrival(arrived, decode, item)), Push::Queued);
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
		buffer.push(1, arrival(start, 0, "v0"));
		buffer.push(2, arrival(start, 0, "a0"));
		let late = start + Duration::from_millis(200);
		let video = |decode, sync, item| Arrival {
			sync,
			..arrival(late, decode, item)
		};
		assert_eq!(buffer.push(1, video(40, false, "v40")), Push::Late);
		assert_eq!(buffer.push(1, video(200, false, "v200")), Push::Waiting);
		assert_eq!(buffer.push(1, video(240, true, "v240")), Push::Queued);
		assert_eq!(buffer.push(2, arrival(late, 180, "a180")), Push::Queued);
		assert_eq!(buffer.dropped(), 2);

		tokio::time::advance(Duration::from_secs(1)).await;
		assert_eq!(due(&mut buffer), ["v0", "a0", "a180", "v240"]);
	}

	/// A consumer that skips a stale group at join counts a discontinuity before anything
	/// went out. The skip keeps the clock, so the tracks stay on one.
	#[tokio::test(start_paused = true)]
	async fn a_skip_before_the_first_release_keeps_one_clock() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		// The video's first group is stale and anchors the clock; the audio is live.
		buffer.push(1, arrival(start, 0, "v0"));
		buffer.push(2, arrival(start, 900, "a900"));
		// The video consumer skips to the live group.
		let skip = start + Duration::from_millis(5);
		assert_eq!(buffer.push(1, after(1, arrival(skip, 900, "v900"))), Push::Queued);
		assert_eq!(buffer.push(1, after(1, arrival(skip, 940, "v940"))), Push::Queued);
		assert_eq!(buffer.push(2, arrival(skip, 940, "a940")), Push::Queued);

		tokio::time::advance(Duration::from_secs(2)).await;
		assert_eq!(
			released(&mut buffer),
			[("v0", 0), ("v900", 0), ("a900", 0), ("v940", 0), ("a940", 0)]
		);
	}

	/// A discontinuity after frames went out opens a new generation, and every track's next
	/// frame runs on it, whether or not that track saw the discontinuity.
	#[tokio::test(start_paused = true)]
	async fn every_track_joins_a_new_generation_at_its_next_frame() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "v0"));
		buffer.push(2, arrival(start, 0, "a0"));
		buffer.push(3, arrival(start, 0, "d0"));
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["v0", "a0", "d0"]);

		// The publisher resumes a second later with its timeline five seconds on.
		let resume = start + Duration::from_secs(1);
		tokio::time::advance(resume - Instant::now()).await;
		assert_eq!(buffer.push(1, after(1, arrival(resume, 5_000, "v5000"))), Push::Queued);
		// The audio crosses no discontinuity of its own; the data crosses the same one.
		let late = resume + Duration::from_millis(10);
		assert_eq!(buffer.push(2, arrival(late, 5_000, "a5000")), Push::Queued);
		assert_eq!(buffer.push(3, after(1, arrival(late, 5_000, "d5000"))), Push::Queued);
		assert_eq!(buffer.push(2, arrival(late, 5_020, "a5020")), Push::Queued);

		tokio::time::advance(DELAY).await;
		assert_eq!(released(&mut buffer), [("v5000", 1), ("a5000", 1), ("d5000", 1)]);
		tokio::time::advance(Duration::from_millis(20)).await;
		assert_eq!(released(&mut buffer), [("a5020", 1)]);
	}

	/// Every frame of a generation goes out before the next generation's, even one the new
	/// clock puts earlier.
	#[tokio::test(start_paused = true)]
	async fn generations_go_out_in_turn() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 0, "v0"));
		buffer.push(1, arrival(start, 40, "v40"));
		buffer.push(2, arrival(start, 20, "a20"));
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["v0"]);

		// A backlog across a jump in the timeline, read in one go.
		let now = Instant::now();
		buffer.push(1, after(1, arrival(now, 5_000, "v5000")));
		buffer.push(2, arrival(now, 4_900, "a4900"));
		buffer.push(2, arrival(now, 5_020, "a5020"));
		tokio::time::advance(Duration::from_secs(1)).await;
		assert_eq!(
			released(&mut buffer),
			[("a20", 0), ("v40", 0), ("a4900", 1), ("v5000", 1), ("a5020", 1)]
		);
	}

	/// Zero holds nothing: frames read together go out at once in decode order, and a
	/// frame behind the clock still goes out.
	#[tokio::test(start_paused = true)]
	async fn zero_delay_releases_on_arrival() {
		let start = Instant::now();
		let mut buffer = Buffer::new(Duration::ZERO);
		buffer.push(1, arrival(start, 0, "v0"));
		buffer.push(1, arrival(start, 40, "v40"));
		buffer.push(2, arrival(start, 20, "a20"));
		assert_eq!(due(&mut buffer), ["v0", "a20", "v40"]);

		let late = start + Duration::from_secs(1);
		assert_eq!(buffer.push(2, arrival(late, 40, "a40")), Push::Queued);
		assert_eq!(due(&mut buffer), ["a40"]);
		assert_eq!(buffer.dropped(), 0);
	}

	#[tokio::test(start_paused = true)]
	async fn clear_starts_a_fresh_clock() {
		let start = Instant::now();
		let mut buffer = Buffer::new(DELAY);
		buffer.push(1, arrival(start, 5_000, "old"));
		buffer.clear();
		assert!(buffer.is_empty());

		tokio::time::advance(Duration::from_secs(1)).await;
		let now = Instant::now();
		assert_eq!(buffer.push(1, arrival(now, 0, "new")), Push::Queued);
		tokio::time::advance(DELAY).await;
		assert_eq!(due(&mut buffer), ["new"]);
	}
}
