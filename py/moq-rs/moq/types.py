"""Re-export moq-ffi record types without the Moq prefix.

Records with duration fields are owned in `_records` instead, so they read as `timedelta`.
"""

from moq_ffi import (
    MoqAudio as Audio,
)
from moq_ffi import (
    MoqAudioCodec as AudioCodec,
)
from moq_ffi import (
    MoqAudioDecoderOutput as AudioDecoderOutput,
)
from moq_ffi import (
    MoqAudioEncoderInput as AudioEncoderInput,
)
from moq_ffi import (
    MoqAudioEncoderOutput as AudioEncoderOutput,
)
from moq_ffi import (
    MoqAudioFormat as AudioFormat,
)
from moq_ffi import (
    MoqAudioFrame as AudioFrame,
)
from moq_ffi import (
    MoqAudioSampleFormat as AudioSampleFormat,
)
from moq_ffi import (
    MoqCatalog as Catalog,
)
from moq_ffi import (
    MoqConnectionStatus as ConnectionStatus,
)
from moq_ffi import (
    MoqContainer as Container,
)
from moq_ffi import (
    MoqContainerFormat as ContainerFormat,
)
from moq_ffi import (
    MoqDimensions as Dimensions,
)
from moq_ffi import (
    MoqErrorScope as ErrorScope,
)
from moq_ffi import (
    MoqFetchGroupOptions as FetchGroupOptions,
)
from moq_ffi import (
    MoqMediaFrame as MediaFrame,
)
from moq_ffi import (
    MoqProtocolError as ProtocolError,
)
from moq_ffi import (
    MoqProtocolKind as ProtocolKind,
)
from moq_ffi import (
    MoqRoute as Route,
)
from moq_ffi import (
    MoqVideo as Video,
)
from moq_ffi import (
    MoqVideoCodec as VideoCodec,
)
from moq_ffi import (
    MoqVideoDecodedFrame as VideoDecodedFrame,
)
from moq_ffi import (
    MoqVideoDecoderOutput as VideoDecoderOutput,
)
from moq_ffi import (
    MoqVideoEncoderInput as VideoEncoderInput,
)
from moq_ffi import (
    MoqVideoEncoderKind as VideoEncoderKind,
)
from moq_ffi import (
    MoqVideoEncoderOutput as VideoEncoderOutput,
)
from moq_ffi import (
    MoqVideoFormat as VideoFormat,
)
from moq_ffi import (
    MoqVideoFrame as VideoFrame,
)
from moq_ffi import (
    MoqVideoHint as VideoHint,
)
from moq_ffi import (
    MoqVideoPixelFormat as VideoPixelFormat,
)
from moq_ffi import (
    MoqVideoProperties,
)

from ._records import Backoff, ConnectionStats, Datagram, Frame, Subscription, TrackInfo

VideoProperties = MoqVideoProperties
"""Video catalog properties shared by every rendition; ``None`` fields clear them."""

__all__ = [
    "Audio",
    "AudioCodec",
    "AudioDecoderOutput",
    "AudioEncoderInput",
    "AudioEncoderOutput",
    "AudioFormat",
    "AudioSampleFormat",
    "VideoFormat",
    "ContainerFormat",
    "AudioFrame",
    "Backoff",
    "Catalog",
    "ConnectionStats",
    "ConnectionStatus",
    "Container",
    "Datagram",
    "Dimensions",
    "ErrorScope",
    "Frame",
    "FetchGroupOptions",
    "ProtocolError",
    "ProtocolKind",
    "MediaFrame",
    "Route",
    "Subscription",
    "TrackInfo",
    "Video",
    "VideoCodec",
    "VideoEncoderInput",
    "VideoEncoderKind",
    "VideoEncoderOutput",
    "VideoFrame",
    "VideoDecodedFrame",
    "VideoDecoderOutput",
    "VideoHint",
    "VideoPixelFormat",
    "VideoProperties",
]
