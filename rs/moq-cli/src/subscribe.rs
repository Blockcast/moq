use std::time::Duration;

use hang::catalog::{AudioCodecKind, VideoCodecKind};
use moq_mux::catalog::{self, CatalogFormat, Stream};
use moq_mux::select;
use tokio::io::AsyncWriteExt;

/// Container format written to stdout on the export (sink) side.
#[derive(Clone, Copy)]
pub enum SubscribeFormat {
	/// Fragmented MP4 (CMAF).
	Fmp4,
	/// Matroska / WebM.
	Mkv,
	/// H.264 Annex-B elementary stream (no container).
	H264,
	/// H.265 Annex-B elementary stream (no container).
	H265,
	/// MPEG-TS (transport stream).
	Ts,
	/// FLV (Flash Video / RTMP).
	Flv,
}

/// `Usage` adapter for [`CatalogFormat`] (which is `#[non_exhaustive]` and so
/// can't derive `ValueEnum` itself).
#[derive(usage::ValueEnum, Clone, Copy)]
pub enum CatalogFormatArg {
	Hang,
	#[usage(name = "hangz")]
	HangZ,
	Msf,
}

impl From<CatalogFormatArg> for CatalogFormat {
	fn from(format: CatalogFormatArg) -> Self {
		match format {
			CatalogFormatArg::Hang => Self::Hang,
			CatalogFormatArg::HangZ => Self::HangZ,
			CatalogFormatArg::Msf => Self::Msf,
		}
	}
}

/// `Usage` adapter for [`VideoCodecKind`].
#[derive(usage::ValueEnum, Clone, Copy)]
pub enum VideoCodecArg {
	H264,
	H265,
	Vp8,
	Vp9,
	Av1,
}

impl From<VideoCodecArg> for VideoCodecKind {
	fn from(value: VideoCodecArg) -> Self {
		match value {
			VideoCodecArg::H264 => Self::H264,
			VideoCodecArg::H265 => Self::H265,
			VideoCodecArg::Vp8 => Self::VP8,
			VideoCodecArg::Vp9 => Self::VP9,
			VideoCodecArg::Av1 => Self::AV1,
		}
	}
}

/// `Usage` adapter for [`AudioCodecKind`].
#[derive(usage::ValueEnum, Clone, Copy)]
pub enum AudioCodecArg {
	Aac,
	Opus,
	Pcm,
}

impl From<AudioCodecArg> for AudioCodecKind {
	fn from(value: AudioCodecArg) -> Self {
		match value {
			AudioCodecArg::Aac => Self::AAC,
			AudioCodecArg::Opus => Self::Opus,
			AudioCodecArg::Pcm => Self::Pcm,
		}
	}
}

/// Rendition selection flags for stdout container sinks and native playback.
/// With no flags set, every rendition is kept.
#[derive(usage::Args, Clone, Default)]
#[usage(unknown_flags = "error", args_override_self = false)]
pub struct SelectArgs {
	/// Pick the video rendition with this exact name.
	#[usage(long)]
	pub video_name: Option<String>,

	/// Keep only video renditions whose codec family matches.
	#[usage(long, value_enum)]
	pub video_codec: Option<VideoCodecArg>,

	/// Pick the audio rendition with this exact name.
	#[usage(long)]
	pub audio_name: Option<String>,

	/// Keep only audio renditions whose codec family matches.
	#[usage(long, value_enum)]
	pub audio_codec: Option<AudioCodecArg>,
}

impl SelectArgs {
	/// Build the rendition selection shared by stdout exports and native playback.
	///
	/// `force` takes the place of `--video-codec`, for a sink whose format implies
	/// one. Pass `None` to use the flag as given.
	pub(crate) fn selection(&self, force: Option<VideoCodecKind>) -> select::Broadcast {
		let mut video = select::Video::default();
		if let Some(name) = &self.video_name {
			video = video.name(name);
		}
		if let Some(codec) = force.or_else(|| self.video_codec.map(Into::into)) {
			video = video.codec(codec);
		}

		let mut audio = select::Audio::default();
		if let Some(name) = &self.audio_name {
			audio = audio.name(name);
		}
		if let Some(codec) = self.audio_codec {
			audio = audio.codec(codec.into());
		}

		select::Broadcast::default().video(video).audio(audio)
	}
}

/// The resolved stdout export settings (built from the `export` flags + format).
#[derive(Clone)]
pub struct SubscribeArgs {
	/// The format to write to stdout.
	pub format: SubscribeFormat,

	/// How far playback may drift from the live edge before skipping groups. TS also
	/// holds every frame this long after its decode time (`--delay`).
	pub max_age: Duration,

	/// How long to wait for the broadcast to come back after it ends (TS only).
	pub linger: Duration,

	/// Cap the output duration: publisher groups by default for fMP4, video GOPs for MKV.
	pub fragment_duration: Option<Duration>,

	/// Pad MPEG-TS output with null packets to this rate, in bits per second,
	/// overriding the catalog's recorded multiplex rate.
	pub mux_rate: Option<u64>,

	/// Catalog format for track discovery (default: detect from the broadcast suffix).
	pub catalog: Option<CatalogFormatArg>,

	/// Rendition selection (name / codec) applied before export.
	pub select: SelectArgs,
}

impl SubscribeArgs {
	/// Resolve the catalog format, falling back to detection from the broadcast
	/// name suffix and then to the default.
	pub fn catalog_format(&self, broadcast: &str) -> CatalogFormat {
		self.catalog
			.map(Into::into)
			.or_else(|| CatalogFormat::detect(broadcast))
			.unwrap_or_default()
	}

	/// Codec implied by the output format. The `h264` / `h265` sinks each force
	/// a single codec family; container formats leave it open.
	fn format_codec(&self) -> Option<VideoCodecKind> {
		match self.format {
			SubscribeFormat::H264 => Some(VideoCodecKind::H264),
			SubscribeFormat::H265 => Some(VideoCodecKind::H265),
			SubscribeFormat::Fmp4 | SubscribeFormat::Mkv | SubscribeFormat::Ts | SubscribeFormat::Flv => None,
		}
	}

	/// Build the rendition selection from the flags, plus any codec forced by
	/// the output format (the `h264` sink implies `codec = H264`).
	///
	/// Errors if `--video-codec` contradicts the format-implied codec, failing
	/// fast in the CLI rather than later in the exporter.
	fn selection(&self) -> anyhow::Result<select::Broadcast> {
		let user_codec = self.select.video_codec.map(VideoCodecKind::from);
		let codec = match (self.format_codec(), user_codec) {
			(Some(fmt), Some(user)) if fmt != user => {
				anyhow::bail!(
					"the output format implies video codec {fmt:?}, but --video-codec {user:?} was passed; \
					 remove --video-codec or pick a matching format"
				);
			}
			(Some(fmt), _) => Some(fmt),
			(None, user) => user,
		};

		Ok(self.select.selection(codec))
	}
}

/// Exports one broadcast from the Origin to stdout in the requested format.
pub struct Subscribe {
	source: moq_mux::Source,
	catalog: CatalogFormat,
	args: SubscribeArgs,
}

impl Subscribe {
	/// Wrap the broadcast + resolved settings; [`run`](Self::run) drives it.
	pub fn new(source: moq_mux::Source, catalog: CatalogFormat, args: SubscribeArgs) -> Self {
		Self { source, catalog, args }
	}

	/// Build the catalog stream, narrowed by the rendition selection flags. The
	/// catalog source honors the requested format (e.g. compressed `HangZ` or `Msf`).
	async fn stream(&self) -> anyhow::Result<catalog::Select<catalog::Consumer>> {
		let consumer = self.source.catalog(self.catalog).await?;
		Ok(consumer.select(self.args.selection()?))
	}

	/// Write the broadcast to stdout until it ends.
	pub async fn run(self) -> anyhow::Result<()> {
		match self.args.format {
			SubscribeFormat::Fmp4 => self.run_fmp4().await,
			SubscribeFormat::Mkv => self.run_mkv().await,
			SubscribeFormat::H264 => self.run_h264().await,
			SubscribeFormat::H265 => self.run_h265().await,
			SubscribeFormat::Ts => self.run_ts().await,
			SubscribeFormat::Flv => self.run_flv().await,
		}
	}

	async fn run_fmp4(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		// Fmp4 builds the merged init segment from the first catalog snapshot, then
		// yields moof+mdat fragments in timestamp order across tracks.
		let stream = self.stream().await?;
		let mut fmp4 = moq_mux::container::fmp4::Export::new(self.source, stream)
			.with_max_age(self.args.max_age)
			.with_fragment_duration(self.args.fragment_duration);

		while let Some(chunk) = fmp4.next().await? {
			stdout.write_all(&chunk).await?;
			stdout.flush().await?;
		}

		Ok(())
	}

	async fn run_mkv(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		// Mkv writes EBML + an unknown-size Segment header, then per-fragment
		// Cluster elements. Avc3/Hev1 sources are transcoded to avc1/hvc1
		// shape internally (synthesizing avcC/hvcC from inline parameter sets).
		let stream = self.stream().await?;
		let mut mkv = moq_mux::container::mkv::Export::new(self.source, stream)
			.with_max_age(self.args.max_age)
			.with_fragment_duration(self.args.fragment_duration);

		while let Some(chunk) = mkv.next().await? {
			stdout.write_all(&chunk).await?;
			stdout.flush().await?;
		}

		Ok(())
	}

	async fn run_h264(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		let stream = self.stream().await?;
		let mut h264 = moq_mux::codec::h264::Export::new(self.source, stream).with_max_age(self.args.max_age);

		while let Some(chunk) = h264.next().await? {
			stdout.write_all(&chunk).await?;
			stdout.flush().await?;
		}

		Ok(())
	}

	async fn run_h265(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		let stream = self.stream().await?;
		let mut h265 = moq_mux::codec::h265::Export::new(self.source, stream).with_max_age(self.args.max_age);

		while let Some(chunk) = h265.next().await? {
			stdout.write_all(&chunk).await?;
			stdout.flush().await?;
		}

		Ok(())
	}

	async fn run_ts(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		// TS emits PAT/PMT then a continuous PES stream (re-emitting PAT/PMT at
		// keyframes for tune-in). Avc3/Hev1 sources pass through as Annex-B; AAC
		// is re-framed as ADTS. `fragment_duration` does not apply to TS. `with_ts`
		// selects the `mpegts` catalog extension so undecoded elementary streams
		// (SCTE-35, teletext, DVB AC-3, ...) are re-emitted verbatim on their PIDs.
		let source = self.source.clone();
		let mut broadcast = source.broadcast().await?;
		let mut ts = moq_mux::container::ts::Export::with_ts(self.source, self.catalog)
			.await?
			.with_delay(self.args.max_age);
		if let Some(mux_rate) = self.args.mux_rate {
			ts = ts.with_mux_rate(mux_rate);
		}

		// A TS byte stream carries no per-frame timing, so delivery time is the only
		// carrier of each frame's spacing: the exporter slices its output on the PCR
		// grid and stamps each slice at its slot boundary, on the contract that the
		// caller writes the bytes at the time the stamp asserts. Draining on arrival
		// instead collapses the clock into position clusters no downstream stage can
		// repair (#2984). The export already releases at the source's pace, so the
		// pacer only spreads each burst of settled slices over the time they cover.
		let mut delivery = Delivery::new(self.args.max_age);
		let linger = self.args.linger;
		loop {
			let end = loop {
				let frame = match ts.next().await {
					Ok(Some(frame)) => frame,
					Ok(None) => break Ok(()),
					Err(err) => break Err(err),
				};
				delivery.deliver(&frame, ts.discontinuity(), &mut stdout).await?;
			};

			// Any end waits out the linger, and on expiry the last one is the result: a
			// clean catalog finish exits 0, a drop or any other failure exits 1.
			if linger.is_zero() {
				return Ok(end?);
			}
			match &end {
				Ok(()) => tracing::info!(?linger, "broadcast finished, waiting for it to return"),
				Err(err) => tracing::warn!(%err, ?linger, "broadcast ended, waiting for it to return"),
			}
			let Some(returned) = resume_within(&source, &broadcast, &mut ts, linger).await? else {
				tracing::info!(?linger, "broadcast did not return");
				return Ok(end?);
			};
			broadcast = returned;
			tracing::info!("broadcast returned, resuming");
		}
	}

	async fn run_flv(self) -> anyhow::Result<()> {
		let mut stdout = tokio::io::stdout();

		// FLV emits the file header plus AVC/AAC sequence headers, then one tag per
		// frame interleaved by timestamp. Avc3 sources are transcoded to avc1 shape
		// internally (synthesizing avcC from inline parameter sets). Only H.264 video
		// and AAC audio are supported; `fragment_duration` does not apply to FLV.
		let mut flv = moq_mux::container::flv::Export::with_catalog_format(self.source, self.catalog)
			.await?
			.with_max_age(self.args.max_age);

		while let Some(chunk) = flv.next().await? {
			stdout.write_all(&chunk).await?;
			stdout.flush().await?;
		}

		Ok(())
	}
}

/// Wait up to `linger` for the `ended` broadcast to return and `ts` to resume on it.
///
/// The linger bounds the whole return, catalog subscription included: a returned
/// broadcast whose catalog never resolves must not hold the export past it. `None`
/// when it did not return in time.
async fn resume_within(
	source: &moq_mux::Source,
	ended: &hang::moq_net::broadcast::Consumer,
	ts: &mut moq_mux::container::ts::Export<moq_mux::container::ts::Ext>,
	linger: Duration,
) -> anyhow::Result<Option<hang::moq_net::broadcast::Consumer>> {
	let resume = async {
		let returned = source.returned(ended).await?;
		ts.resume().await?;
		anyhow::Ok(returned)
	};
	match tokio::time::timeout(linger, resume).await {
		Ok(returned) => Ok(Some(returned?)),
		Err(_) => Ok(None),
	}
}

/// Paced stdout delivery for the TS export: sleeps until each frame's send instant.
///
/// The export holds every frame its delay and lays the multiplex out a slot at a time,
/// so it hands slices over at the source's pace, a few at once. The pacer spreads each
/// handful over the slots it covers, holding up to the delay ahead of the wall clock.
/// A sink that falls behind writes what is overdue at once and catches up.
struct Delivery {
	discontinuity: u64,
	pacer: moq_mux::Pacer,
}

impl Delivery {
	fn new(lead: Duration) -> Self {
		Self {
			pacer: moq_mux::Pacer::default().with_lead(lead),
			discontinuity: 0,
		}
	}

	/// Write one export frame to `out` at its paced instant. A new `discontinuity`
	/// (the program clock restarted) re-anchors the pacing on this frame.
	async fn deliver(
		&mut self,
		frame: &moq_mux::container::Frame,
		discontinuity: u64,
		out: &mut (impl tokio::io::AsyncWrite + Unpin),
	) -> anyhow::Result<()> {
		// tokio's clock rather than the bare std one so tests can pause it; in
		// production they are identical.
		let now = tokio::time::Instant::now().into_std();
		let send_at = match std::mem::replace(&mut self.discontinuity, discontinuity) == discontinuity {
			true => self.pacer.pace(frame.timestamp, now),
			false => self.pacer.hurry(frame.timestamp, now),
		};
		tokio::time::sleep_until(tokio::time::Instant::from_std(send_at)).await;
		out.write_all(&frame.payload).await?;
		out.flush().await?;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use hang::moq_net::{Timescale, Timestamp};

	fn frame(value: u64, scale: Timescale) -> moq_mux::container::Frame {
		moq_mux::container::Frame {
			timestamp: Timestamp::new(value, scale).unwrap(),
			duration: None,
			payload: bytes::Bytes::from_static(&[0x47; 188]),
			keyframe: false,
		}
	}

	/// Regression for #2984: the TS stdout writer must deliver each frame at the
	/// instant its timestamp asserts, not as fast as frames arrive. The exporter
	/// stamps PCR grid frames in microseconds and media frames at the source's own
	/// timescale, so the spacing must also survive a scale change mid-stream.
	#[tokio::test(start_paused = true)]
	async fn ts_frames_are_paced_on_the_media_clock() {
		let mut delivery = Delivery::new(Duration::from_millis(500));
		let mut out = Vec::new();

		let start = tokio::time::Instant::now();

		// The first frame anchors the pacer and is written immediately.
		delivery
			.deliver(&frame(0, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();
		assert_eq!(start.elapsed(), Duration::ZERO);

		// A PCR slot 25ms later waits for its grid boundary.
		delivery
			.deliver(&frame(25_000, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();
		assert_eq!(start.elapsed(), Duration::from_millis(25));

		// A media frame at the source's 90 kHz timescale paces on the same clock.
		delivery
			.deliver(&frame(3_600, Timescale::new(90_000).unwrap()), 0, &mut out)
			.await
			.unwrap();
		assert_eq!(start.elapsed(), Duration::from_millis(40));

		assert_eq!(out.len(), 3 * 188, "every payload was written");
	}

	/// A sink that falls behind writes what is overdue at once, then paces again.
	#[tokio::test(start_paused = true)]
	async fn a_slow_sink_catches_up() {
		let mut delivery = Delivery::new(Duration::from_millis(500));
		let mut out = Vec::new();

		let start = tokio::time::Instant::now();
		delivery
			.deliver(&frame(0, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();

		// The writer stalls for 2s (a blocked pipe): every slot after this is overdue.
		tokio::time::advance(Duration::from_secs(2)).await;
		delivery
			.deliver(&frame(400_000, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();
		assert_eq!(
			start.elapsed(),
			Duration::from_secs(2),
			"an overdue slot writes at once"
		);
	}

	/// Slots the export has ready at once still go out on their grid.
	#[tokio::test(start_paused = true)]
	async fn a_buffered_producer_keeps_pacing() {
		let mut delivery = Delivery::new(Duration::from_millis(500));
		let mut out = Vec::new();

		let start = tokio::time::Instant::now();
		delivery
			.deliver(&frame(0, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();

		for slot in 1..=40u64 {
			delivery
				.deliver(&frame(slot * 25_000, Timescale::MICRO), 0, &mut out)
				.await
				.unwrap();
			assert_eq!(
				start.elapsed(),
				Duration::from_millis(slot * 25),
				"slot {slot} must be paced, not shed"
			);
		}
	}
	#[tokio::test(start_paused = true)]
	async fn a_rewind_re_anchors_the_pacer() {
		let mut delivery = Delivery::new(Duration::from_millis(500));
		let mut out = tokio::io::sink();
		delivery
			.deliver(&frame(10_000_000, Timescale::MICRO), 0, &mut out)
			.await
			.unwrap();
		let now = tokio::time::Instant::now();
		delivery
			.deliver(&frame(0, Timescale::MICRO), 1, &mut out)
			.await
			.unwrap();
		assert_eq!(now.elapsed(), Duration::ZERO);
		delivery
			.deliver(&frame(40_000, Timescale::MICRO), 1, &mut out)
			.await
			.unwrap();
		assert_eq!(now.elapsed(), Duration::from_millis(40));
	}

	/// A broadcast that returns but never serves its catalog gives up at the linger,
	/// rather than waiting on the catalog past it.
	#[tokio::test(start_paused = true)]
	async fn a_return_without_a_catalog_expires_with_the_linger() {
		let (origin, driver) = hang::moq_net::origin::Producer::new(Default::default());
		tokio::spawn(hang::moq_net::time::run(driver));
		let source = moq_mux::Source::new(origin.consume(), "live");

		let mut first = origin.publish("live", Default::default()).unwrap();
		let catalog = moq_mux::catalog::Producer::new(&mut first, Default::default()).unwrap();
		let ended = source.broadcast().await.unwrap();
		let mut ts = moq_mux::container::ts::Export::with_ts(source.clone(), CatalogFormat::Hang)
			.await
			.unwrap();
		drop((first, catalog));

		// Back, but its catalog request is never answered.
		let second = origin.publish("live", Default::default()).unwrap();
		let _unanswered = second.dynamic();

		let linger = Duration::from_secs(10);
		let start = tokio::time::Instant::now();
		let resumed = resume_within(&source, &ended, &mut ts, linger).await.unwrap();
		assert!(resumed.is_none(), "a return that never resumes is no return");
		assert_eq!(start.elapsed(), linger);
	}
}
