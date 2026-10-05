//! Typed handles that make a track all-timed or all-untimed.
//!
//! Readers learn the timing at runtime, when the subscription is accepted, through
//! [`track::Subscriber::timing`](crate::track::Subscriber::timing). Writers pick it when
//! they create the track.
//!
//! Variant A (this module): the timescale is a runtime value in [`track::Info`]. The
//! same `Timed`/`Untimed` handles wrap a writer (`Timed<track::Producer>`) or a reader
//! (`Timed<track::Subscriber>`, the default), so the timing is in the type and the scale
//! is in the value. Variant B ([`crate::typed`]) puts the scale in the writer's type too.
//!
//! [`track::Info`]: crate::track::Info

/// Typed track handles, re-exported from [`crate::track`].
pub(super) mod track {
	use std::task::Poll;

	use bytes::Bytes;

	use crate::frame::Frame;
	use crate::{Error, IntoBytes, Result, Timescale, Timestamp, group, track};

	use super::group::{Timed as TimedGroup, Untimed as UntimedGroup};

	/// A subscribed track, split by whether its frames carry timestamps.
	pub enum Timing {
		/// Every frame and datagram carries a timestamp.
		Timed(Timed),
		/// No frame or datagram carries a timestamp.
		Untimed(Untimed),
	}

	/// A timed track: every frame and datagram carries a timestamp at [`Self::timescale`].
	///
	/// Reads through a [`track::Subscriber`] (the default) or writes through a
	/// [`track::Producer`].
	pub struct Timed<H = track::Subscriber> {
		inner: H,
		timescale: Timescale,
	}

	/// An untimed track: frames and datagrams are bare payloads.
	///
	/// Reads through a [`track::Subscriber`] (the default) or writes through a
	/// [`track::Producer`].
	pub struct Untimed<H = track::Subscriber> {
		inner: H,
	}

	impl<H> Timed<H> {
		/// Units per second for every timestamp on this track.
		pub fn timescale(&self) -> Timescale {
			self.timescale
		}
	}

	impl track::Subscriber {
		/// Split this subscriber by the track's timing, as the publisher declared it.
		pub fn timing(self) -> Timing {
			match self.info().timescale {
				Some(timescale) => Timing::Timed(Timed { inner: self, timescale }),
				None => Timing::Untimed(Untimed { inner: self }),
			}
		}
	}

	impl track::Producer {
		/// Write this track as timed, taking a [`crate::Timed`] per frame.
		///
		/// Refused with [`Error::TimestampMismatch`] when [`track::Info::timescale`] is `None`.
		pub fn timed(self) -> Result<Timed<Self>> {
			let timescale = self.info().timescale.ok_or(Error::TimestampMismatch)?;
			Ok(Timed { inner: self, timescale })
		}

		/// Write this track as untimed, taking a bare payload per frame.
		///
		/// Refused with [`Error::TimestampMismatch`] when [`track::Info::timescale`] is set.
		pub fn untimed(self) -> Result<Untimed<Self>> {
			if self.info().timescale.is_some() {
				return Err(Error::TimestampMismatch);
			}
			Ok(Untimed { inner: self })
		}
	}

	impl Timed<track::Subscriber> {
		/// The track's [`track::Info`].
		pub fn info(&self) -> &track::Info {
			self.inner.info()
		}

		/// Poll for the next group in arrival order.
		pub fn poll_recv_group(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<TimedGroup>>> {
			self.inner
				.poll_recv_group(waiter)
				.map_ok(|group| group.map(TimedGroup::new))
		}

		/// Receive the next group in arrival order.
		pub async fn recv_group(&mut self) -> Result<Option<TimedGroup>> {
			kio::wait(|waiter| self.poll_recv_group(waiter)).await
		}

		/// Poll for the next datagram in arrival order.
		pub fn poll_recv_datagram(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<Frame>>> {
			self.inner.poll_recv_datagram(waiter).map_ok(|datagram| {
				datagram.map(|datagram| Frame {
					timestamp: datagram.timestamp,
					payload: datagram.payload,
				})
			})
		}

		/// Receive the next datagram in arrival order.
		pub async fn recv_datagram(&mut self) -> Result<Option<Frame>> {
			kio::wait(|waiter| self.poll_recv_datagram(waiter)).await
		}
	}

	impl Untimed<track::Subscriber> {
		/// The track's [`track::Info`].
		pub fn info(&self) -> &track::Info {
			self.inner.info()
		}

		/// Poll for the next group in arrival order.
		pub fn poll_recv_group(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<UntimedGroup>>> {
			self.inner
				.poll_recv_group(waiter)
				.map_ok(|group| group.map(UntimedGroup::new))
		}

		/// Receive the next group in arrival order.
		pub async fn recv_group(&mut self) -> Result<Option<UntimedGroup>> {
			kio::wait(|waiter| self.poll_recv_group(waiter)).await
		}

		/// Poll for the next datagram's payload in arrival order.
		pub fn poll_recv_datagram(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<Bytes>>> {
			self.inner
				.poll_recv_datagram(waiter)
				.map_ok(|datagram| datagram.map(|datagram| datagram.payload))
		}

		/// Receive the next datagram's payload in arrival order.
		pub async fn recv_datagram(&mut self) -> Result<Option<Bytes>> {
			kio::wait(|waiter| self.poll_recv_datagram(waiter)).await
		}
	}

	impl Timed<track::Producer> {
		/// The track's name, unique within its broadcast.
		pub fn name(&self) -> &str {
			self.inner.name()
		}

		/// Create a group with the next sequence number.
		pub fn append_group(&self) -> Result<TimedGroup<group::Producer>> {
			Ok(TimedGroup::new(self.inner.append_group()?))
		}

		/// Create a group with the given sequence number.
		pub fn create_group(&self, info: group::Info) -> Result<TimedGroup<group::Producer>> {
			Ok(TimedGroup::new(self.inner.create_group(info)?))
		}

		/// Write a single-frame group.
		pub fn write_frame<B: IntoBytes>(&mut self, frame: crate::Timed<B>) -> Result<()> {
			self.inner.write_frame(frame.at, frame.value)
		}

		/// Append a datagram with the next sequence number, returning the sequence.
		pub fn append_datagram<B: IntoBytes>(&mut self, datagram: crate::Timed<B>) -> Result<u64> {
			self.inner.append_datagram(datagram.at, datagram.value)
		}

		/// End the track after its last group.
		pub fn finish(&self) -> Result<()> {
			self.inner.finish()
		}

		/// A cheap, cloneable handle to subscribe with.
		pub fn consume(&self) -> track::Consumer {
			self.inner.consume()
		}
	}

	impl Untimed<track::Producer> {
		/// The track's name, unique within its broadcast.
		pub fn name(&self) -> &str {
			self.inner.name()
		}

		/// Create a group with the next sequence number.
		pub fn append_group(&self) -> Result<UntimedGroup<group::Producer>> {
			Ok(UntimedGroup::new(self.inner.append_group()?))
		}

		/// Create a group with the given sequence number.
		pub fn create_group(&self, info: group::Info) -> Result<UntimedGroup<group::Producer>> {
			Ok(UntimedGroup::new(self.inner.create_group(info)?))
		}

		/// Write a single-frame group.
		pub fn write_frame<B: IntoBytes>(&mut self, payload: B) -> Result<()> {
			self.inner.write_frame(Timestamp::now(), payload)
		}

		/// Append a datagram with the next sequence number, returning the sequence.
		pub fn append_datagram<B: IntoBytes>(&mut self, payload: B) -> Result<u64> {
			self.inner.append_datagram(Timestamp::now(), payload)
		}

		/// End the track after its last group.
		pub fn finish(&self) -> Result<()> {
			self.inner.finish()
		}

		/// A cheap, cloneable handle to subscribe with.
		pub fn consume(&self) -> track::Consumer {
			self.inner.consume()
		}
	}
}

/// Typed group handles, re-exported from [`crate::group`].
pub(super) mod group {
	use std::task::Poll;

	use bytes::Bytes;

	use crate::frame::{self, Frame};
	use crate::{Error, IntoBytes, Result, Timescale, Timestamp, group};

	/// A group of a timed track: every frame carries a timestamp.
	///
	/// Reads through a [`group::Consumer`] (the default) or writes through a
	/// [`group::Producer`].
	pub struct Timed<H = group::Consumer> {
		inner: H,
	}

	/// A group of an untimed track: frames are bare payloads.
	///
	/// Reads through a [`group::Consumer`] (the default) or writes through a
	/// [`group::Producer`].
	pub struct Untimed<H = group::Consumer> {
		inner: H,
	}

	impl<H> Timed<H> {
		// Only a typed track hands these out, having checked the timing.
		pub(super) fn new(inner: H) -> Self {
			Self { inner }
		}
	}

	impl<H> Untimed<H> {
		pub(super) fn new(inner: H) -> Self {
			Self { inner }
		}
	}

	impl<H: std::ops::Deref<Target = group::Info>> std::ops::Deref for Timed<H> {
		type Target = group::Info;

		fn deref(&self) -> &group::Info {
			&self.inner
		}
	}

	impl<H: std::ops::Deref<Target = group::Info>> std::ops::Deref for Untimed<H> {
		type Target = group::Info;

		fn deref(&self) -> &group::Info {
			&self.inner
		}
	}

	impl Timed<group::Consumer> {
		/// Units per second for every timestamp in this group.
		pub fn timescale(&self) -> Timescale {
			self.inner.timescale()
		}

		/// Poll for the next frame, timestamp and payload.
		pub fn poll_read_frame(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<Frame>>> {
			self.inner.poll_read_frame(waiter)
		}

		/// Read the next frame, timestamp and payload.
		pub async fn read_frame(&mut self) -> Result<Option<Frame>> {
			self.inner.read_frame().await
		}

		/// Fill `out` with every frame that is ready, without blocking.
		pub fn poll_read_frames<const N: usize>(
			&mut self,
			waiter: &kio::Waiter,
			out: &mut frame::Buffer<N>,
		) -> Poll<Result<usize>> {
			self.inner.poll_read_frames(waiter, out)
		}

		/// Fill `out` with every frame that is ready, waiting for at least one.
		pub async fn read_frames<'a, const N: usize>(
			&mut self,
			out: &'a mut frame::Buffer<N>,
		) -> Result<&'a mut [Frame]> {
			self.inner.read_frames(out).await
		}

		/// Return the next frame for chunked reading.
		pub async fn next_frame(&mut self) -> Result<Option<frame::Consumer>> {
			self.inner.next_frame().await
		}
	}

	impl Untimed<group::Consumer> {
		/// Poll for the next frame's payload.
		pub fn poll_read_frame(&mut self, waiter: &kio::Waiter) -> Poll<Result<Option<Bytes>>> {
			self.inner
				.poll_read_frame(waiter)
				.map_ok(|frame| frame.map(|frame| frame.payload))
		}

		/// Read the next frame's payload.
		pub async fn read_frame(&mut self) -> Result<Option<Bytes>> {
			kio::wait(|waiter| self.poll_read_frame(waiter)).await
		}
	}

	impl Timed<group::Producer> {
		/// Write a whole frame.
		pub fn write_frame<B: IntoBytes>(&mut self, frame: crate::Timed<B>) -> Result<()> {
			self.inner.write_frame(frame.at, frame.value)
		}

		/// Open a frame of `size` bytes captured `at`, to write in chunks.
		pub fn create_frame(&mut self, size: u64, at: Timestamp) -> Result<frame::Producer<'_>> {
			self.inner.create_frame(frame::Info { size, timestamp: at })
		}

		/// Write a batch of frames at once, draining `frames`.
		pub fn write_frames<const N: usize>(&mut self, frames: &mut frame::Buffer<N>) -> Result<()> {
			self.inner.write_frames(frames)
		}

		/// Mark the group complete.
		pub fn finish(&self) -> Result<()> {
			self.inner.finish()
		}

		/// Abort the group with `err`.
		pub fn abort(self, err: Error) -> Result<()> {
			self.inner.abort(err)
		}
	}

	impl Untimed<group::Producer> {
		/// Write a whole frame.
		pub fn write_frame<B: IntoBytes>(&mut self, payload: B) -> Result<()> {
			self.inner.write_frame(Timestamp::now(), payload)
		}

		/// Open a frame of `size` bytes, to write in chunks.
		pub fn create_frame(&mut self, size: u64) -> Result<frame::Producer<'_>> {
			self.inner.create_frame(frame::Info {
				size,
				timestamp: Timestamp::now(),
			})
		}

		/// Mark the group complete.
		pub fn finish(&self) -> Result<()> {
			self.inner.finish()
		}

		/// Abort the group with `err`.
		pub fn abort(self, err: Error) -> Result<()> {
			self.inner.abort(err)
		}
	}
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;

	use crate::{Error, Timed, Timescale, Timestamp, broadcast, track};

	fn ms(value: u64) -> Timestamp {
		Timestamp::from_millis(value).unwrap()
	}

	#[tokio::test]
	async fn a_timed_track_reads_timestamps() {
		let broadcast = broadcast::Info::default().produce();
		let info = track::Info::default().with_timescale(Timescale::MICRO);
		let mut video = broadcast.create_track("video", info).unwrap().timed().unwrap();
		let consumer = video.consume();

		video.write_frame(Timed::new(&b"key"[..], ms(2))).unwrap();
		video.append_datagram(Timed::new(&b"dg"[..], ms(3))).unwrap();

		let track::Timing::Timed(mut reader) = consumer.subscribe(None).await.unwrap().timing() else {
			panic!("a track with a timescale reads timed");
		};
		assert_eq!(reader.timescale(), Timescale::MICRO);

		let mut group = reader.recv_group().await.unwrap().unwrap();
		let frame = group.read_frame().await.unwrap().unwrap();
		assert_eq!(frame.timestamp, Timestamp::from_micros(2_000).unwrap());
		assert_eq!(frame.payload, Bytes::from_static(b"key"));

		let datagram = reader.recv_datagram().await.unwrap().unwrap();
		assert_eq!(datagram.timestamp.value(), 3_000);
	}

	#[tokio::test]
	async fn an_untimed_track_reads_bare_payloads() {
		let broadcast = broadcast::Info::default().produce();
		let mut chat = broadcast.create_track("chat", None).unwrap().untimed().unwrap();
		let consumer = chat.consume();

		let mut group = chat.append_group().unwrap();
		group.write_frame(&b"hi"[..]).unwrap();
		group.finish().unwrap();
		chat.append_datagram(&b"dg"[..]).unwrap();

		let track::Timing::Untimed(mut reader) = consumer.subscribe(None).await.unwrap().timing() else {
			panic!("a track without a timescale reads untimed");
		};
		let mut group = reader.recv_group().await.unwrap().unwrap();
		assert_eq!(group.read_frame().await.unwrap().unwrap(), Bytes::from_static(b"hi"));
		assert_eq!(
			reader.recv_datagram().await.unwrap().unwrap(),
			Bytes::from_static(b"dg")
		);
	}

	#[test]
	fn the_writer_must_match_the_track() {
		let broadcast = broadcast::Info::default().produce();
		let untimed = broadcast.create_track("chat", None).unwrap();
		assert!(matches!(untimed.timed(), Err(Error::TimestampMismatch)));

		let info = track::Info::default().with_timescale(Timescale::MILLI);
		let timed = broadcast.create_track("video", info).unwrap();
		assert!(matches!(timed.untimed(), Err(Error::TimestampMismatch)));
	}
}
