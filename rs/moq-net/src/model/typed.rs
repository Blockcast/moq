//! Variant B mock-up: the writer's timing and timescale as a type parameter.
//!
//! A writer names its timing when it creates the track: [`Untimed`], or a scale such as
//! [`Milli`], [`Micro`], or [`Hz<90_000>`](Hz). The track declares that scale, and
//! the writer's methods take a [`crate::Timed`] or a bare payload to match, so neither the
//! timedness nor the declared scale can disagree with the writes.
//!
//! Readers are unchanged from variant A: a received track's timescale is only learned at
//! runtime, so [`track::Subscriber::timing`](crate::track::Subscriber::timing) still splits
//! it. Relays keep the untyped [`crate::track::Producer`], whose scale is runtime state.
//!
//! Landing this variant would make the core handles generic (`track::Producer<T>`) rather
//! than wrapping them; the wrappers here keep both variants compiling side by side.

use std::marker::PhantomData;
use std::sync::Arc;

use crate::{Error, IntoBytes, Result, Timescale, Timestamp, broadcast};

mod sealed {
	pub trait Sealed {}
}

/// A writer's timing, fixed when it creates the track.
pub trait Timing: sealed::Sealed + Send + Sync + 'static {
	/// The timescale the track declares, or `None` for an untimed track.
	const TIMESCALE: Option<Timescale>;
}

/// A timing whose frames carry timestamps.
pub trait Scale: Timing {}

/// No timestamps: frames are bare payloads.
pub struct Untimed;

/// `N` timestamp units per second.
pub struct Hz<const N: u64>;

/// Millisecond timestamps.
pub type Milli = Hz<1_000>;

/// Microsecond timestamps.
pub type Micro = Hz<1_000_000>;

/// Nanosecond timestamps.
pub type Nano = Hz<1_000_000_000>;

impl sealed::Sealed for Untimed {}
impl Timing for Untimed {
	const TIMESCALE: Option<Timescale> = None;
}

impl<const N: u64> sealed::Sealed for Hz<N> {}
impl<const N: u64> Timing for Hz<N> {
	// An invalid `N` (zero, or past the varint range) fails to compile.
	const TIMESCALE: Option<Timescale> = match Timescale::new(N) {
		Ok(scale) => Some(scale),
		Err(_) => panic!("invalid timescale"),
	};
}
impl<const N: u64> Scale for Hz<N> {}

impl broadcast::Producer {
	/// Produce a track whose writes are typed by `T`, which also sets its timescale.
	///
	/// Refused with [`Error::TimestampMismatch`] when `info` declares a different timescale.
	pub fn create_typed<T: Timing>(
		&self,
		name: impl Into<Arc<str>>,
		info: impl Into<Option<crate::track::Info>>,
	) -> Result<track::Producer<T>> {
		let mut info = info.into().unwrap_or_default();
		if info.timescale.is_some() && info.timescale != T::TIMESCALE {
			return Err(Error::TimestampMismatch);
		}
		info.timescale = T::TIMESCALE;
		Ok(track::Producer {
			inner: self.create_track(name, info)?,
			_timing: PhantomData,
		})
	}
}

/// Typed track writers.
pub mod track {
	use super::*;

	/// Writes a track whose timing is `T`.
	pub struct Producer<T: Timing> {
		pub(super) inner: crate::track::Producer,
		pub(super) _timing: PhantomData<T>,
	}

	impl<T: Timing> Producer<T> {
		/// The track's name, unique within its broadcast.
		pub fn name(&self) -> &str {
			self.inner.name()
		}

		/// Create a group with the next sequence number.
		pub fn append_group(&self) -> Result<super::group::Producer<T>> {
			Ok(super::group::Producer::new(self.inner.append_group()?))
		}

		/// Create a group with the given sequence number.
		pub fn create_group(&self, info: crate::group::Info) -> Result<super::group::Producer<T>> {
			Ok(super::group::Producer::new(self.inner.create_group(info)?))
		}

		/// End the track after its last group.
		pub fn finish(&self) -> Result<()> {
			self.inner.finish()
		}

		/// A cheap, cloneable handle to subscribe with.
		pub fn consume(&self) -> crate::track::Consumer {
			self.inner.consume()
		}
	}

	impl<T: Scale> Producer<T> {
		/// Write a single-frame group.
		pub fn write_frame<B: IntoBytes>(&mut self, frame: crate::Timed<B>) -> Result<()> {
			self.inner.write_frame(frame.at, frame.value)
		}

		/// Append a datagram with the next sequence number, returning the sequence.
		pub fn append_datagram<B: IntoBytes>(&mut self, datagram: crate::Timed<B>) -> Result<u64> {
			self.inner.append_datagram(datagram.at, datagram.value)
		}
	}

	impl Producer<Untimed> {
		/// Write a single-frame group.
		pub fn write_frame<B: IntoBytes>(&mut self, payload: B) -> Result<()> {
			self.inner.write_frame(Timestamp::now(), payload)
		}

		/// Append a datagram with the next sequence number, returning the sequence.
		pub fn append_datagram<B: IntoBytes>(&mut self, payload: B) -> Result<u64> {
			self.inner.append_datagram(Timestamp::now(), payload)
		}
	}
}

/// Typed group writers.
pub mod group {
	use super::*;
	use crate::frame;

	/// Writes a group of a track whose timing is `T`.
	pub struct Producer<T: Timing> {
		inner: crate::group::Producer,
		_timing: PhantomData<T>,
	}

	impl<T: Timing> Producer<T> {
		pub(super) fn new(inner: crate::group::Producer) -> Self {
			Self {
				inner,
				_timing: PhantomData,
			}
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

	impl<T: Timing> std::ops::Deref for Producer<T> {
		type Target = crate::group::Info;

		fn deref(&self) -> &crate::group::Info {
			&self.inner
		}
	}

	impl<T: Scale> Producer<T> {
		/// Write a whole frame.
		pub fn write_frame<B: IntoBytes>(&mut self, frame: crate::Timed<B>) -> Result<()> {
			self.inner.write_frame(frame.at, frame.value)
		}

		/// Open a frame of `size` bytes captured `at`, to write in chunks.
		pub fn create_frame(&mut self, size: u64, at: Timestamp) -> Result<frame::Producer<'_>> {
			self.inner.create_frame(frame::Info { size, timestamp: at })
		}
	}

	impl Producer<Untimed> {
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
	}
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;

	use super::*;
	use crate::{Timed, track as model};

	#[tokio::test]
	async fn the_type_sets_the_timescale() {
		let broadcast = broadcast::Info::default().produce();
		let mut video = broadcast.create_typed::<Hz<90_000>>("video", None).unwrap();
		video
			.write_frame(Timed::new(&b"key"[..], Timestamp::from_millis(1).unwrap()))
			.unwrap();

		let model::Timing::Timed(mut reader) = video.consume().subscribe(None).await.unwrap().timing() else {
			panic!("a scaled writer makes a timed track");
		};
		assert_eq!(reader.timescale(), Timescale::new(90_000).unwrap());
		let mut group = reader.recv_group().await.unwrap().unwrap();
		assert_eq!(group.read_frame().await.unwrap().unwrap().timestamp.value(), 90);
	}

	#[tokio::test]
	async fn an_untimed_writer_makes_an_untimed_track() {
		let broadcast = broadcast::Info::default().produce();
		let mut chat = broadcast.create_typed::<Untimed>("chat", None).unwrap();
		chat.write_frame(&b"hi"[..]).unwrap();

		let model::Timing::Untimed(mut reader) = chat.consume().subscribe(None).await.unwrap().timing() else {
			panic!("an untimed writer makes an untimed track");
		};
		let mut group = reader.recv_group().await.unwrap().unwrap();
		assert_eq!(group.read_frame().await.unwrap().unwrap(), Bytes::from_static(b"hi"));
	}

	#[test]
	fn a_conflicting_info_is_refused() {
		let broadcast = broadcast::Info::default().produce();
		let info = model::Info::default().with_timescale(Timescale::MILLI);
		assert!(matches!(
			broadcast.create_typed::<Micro>("video", info),
			Err(Error::TimestampMismatch)
		));
	}
}
