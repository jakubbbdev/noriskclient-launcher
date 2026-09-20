
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use ffmpeg_next::ffi as ff;

use crate::buffer::{Clip, Packet};
use crate::encoder::hw::av_error;
use crate::encoder::video::TIME_BASE_DEN;
use crate::writer::{write_mp4, TrackInfo};

type Ratio = (i64, i64);

#[derive(Debug, Clone)]
pub struct VerticalResult {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub size_bytes: u64,
}

fn centre_crop(width: u32, height: u32, ratio: Ratio) -> (u32, u32, u32, u32) {
    let (across, down) = ratio;
    let (width, height) = (width as i64, height as i64);

    if (height * across / down) & !1 >= width {
        let keep_width = width & !1;
        let keep_height = (keep_width * down / across).min(height) & !1;
        let spare = height - keep_height;
        let top = (spare / 2) & !1;
        return (
            0,
            (width - keep_width) as u32,
            top as u32,
            (spare - top) as u32,
        );
    }

    let keep_height = height & !1;
    let keep_width = (keep_height * across / down) & !1;
    let spare = width - keep_width;
    let left = (spare / 2) & !1;

    (
        left as u32,
        (spare - left) as u32,
        0,
        (height - keep_height) as u32,
    )
}

fn crop_ratio(shape: norisk_ipc::ClipShape, width: u32, height: u32) -> Ratio {
    shape.ratio().unwrap_or((width as i64, height as i64))
}

pub fn to_vertical(
    source: &Path,
    destination: &Path,
    shape: norisk_ipc::ClipShape,
    overlays: &[norisk_ipc::ClipOverlay],
    progress: impl Fn(u32, u32),
) -> Result<VerticalResult> {
    let clip = crate::trim::read(source)?;
    let ratio = crop_ratio(shape, clip.track.width, clip.track.height);

    let (left, right, top, bottom) = centre_crop(clip.track.width, clip.track.height, ratio);
    let width = clip.track.width.saturating_sub(left + right);
    let height = clip.track.height.saturating_sub(top + bottom);

    if width == 0 || height == 0 {
        bail!(
            "a {}x{} clip has no {}:{} middle to cut",
            clip.track.width,
            clip.track.height,
            ratio.0,
            ratio.1
        );
    }
    if (left, right, top, bottom) == (0, 0, 0, 0) {
        log::info!(
            "{width}x{height} is already {}:{}; only re-encoding",
            ratio.0,
            ratio.1
        );
    }

    log::info!(
        "Cutting {}x{} down to {width}x{height} (dropping {left}+{right} across, {top}+{bottom} down)",
        clip.track.width,
        clip.track.height,
    );

    let mut decoder = Decoder::open(&clip.track)?;
    let mut encoder = Encoder::open(width, height, clip.track.fps)?;

    let total = clip.video.len() as u32;
    let mut packets: Vec<Packet> = Vec::with_capacity(clip.video.len());
    let origin = clip.video.first().map(|p| p.pts).unwrap_or(0);

    for (index, packet) in clip.video.iter().enumerate() {
        for frame in decoder.push(packet)? {
            paint(&frame, origin, overlays)?;
            packets.extend(encoder.push(frame, (left, right, top, bottom))?);
        }
        progress(index as u32 + 1, total);
    }
    for frame in decoder.finish()? {
        paint(&frame, origin, overlays)?;
        packets.extend(encoder.push(frame, (left, right, top, bottom))?);
    }
    packets.extend(encoder.finish()?);
    progress(total, total);

    if packets.is_empty() {
        bail!("the clip produced no frames to write");
    }

    let audio = crate::trim::as_recorded_mix(&clip);

    let bytes = packets.iter().map(|p| p.len() as u64).sum::<u64>()
        + audio
            .iter()
            .flat_map(|track| track.packets.iter())
            .map(|p| p.len() as u64)
            .sum::<u64>();

    let start_pts = packets.first().map(|p| p.pts).unwrap_or(0);
    let end_pts = packets.last().map(|p| p.pts).unwrap_or(start_pts);

    let cut = Clip {
        start_pts,
        end_pts,
        bytes,
        playback_start_pts: start_pts,
        packets,
    };

    let track = TrackInfo {
        width,
        height,
        fps: clip.track.fps,
        time_base_den: TIME_BASE_DEN as i64,
        codec: norisk_ipc::ClipCodec::H264,
        extradata: encoder.extradata(),
    };

    let written = write_mp4(&cut, destination, &track, &audio)
        .with_context(|| format!("could not write {}", destination.display()))?;

    Ok(VerticalResult {
        path: written.path,
        width,
        height,
        duration_seconds: written.duration_seconds,
        size_bytes: written.size_bytes,
    })
}

fn paint(frame: &Frame, origin: i64, overlays: &[norisk_ipc::ClipOverlay]) -> Result<()> {
    use crate::overlay::{apply, covers, halve, rect_in, Plane};

    if overlays.is_empty() {
        return Ok(());
    }

    unsafe {
        let seconds = ((*frame.0).pts - origin) as f64 / TIME_BASE_DEN as f64;
        let wanted: Vec<_> = overlays.iter().filter(|o| covers(o, seconds)).collect();
        if wanted.is_empty() {
            return Ok(());
        }

        let rc = ff::av_frame_make_writable(frame.0);
        if rc < 0 {
            bail!("could not make a frame writable to paint on: {}", av_error(rc));
        }

        let width = (*frame.0).width.max(0) as usize;
        let height = (*frame.0).height.max(0) as usize;
        let chroma_width = width.div_ceil(2);
        let chroma_height = height.div_ceil(2);

        for overlay in wanted {
            let Some(rect) = rect_in(overlay, width, height) else {
                continue;
            };

            let stride = (*frame.0).linesize[0].max(0) as usize;
            if (*frame.0).data[0].is_null() || stride < width {
                bail!("the decoder handed back a frame without a usable luma plane");
            }
            let mut luma = Plane {
                data: std::slice::from_raw_parts_mut((*frame.0).data[0], stride * height),
                stride,
                width,
                height,
                channel: crate::overlay::Channel::Luma,
            };
            apply(&mut luma, rect, &overlay.kind);

            let chroma = halve(rect);
            for index in 1..3 {
                let stride = (*frame.0).linesize[index].max(0) as usize;
                if (*frame.0).data[index].is_null() || stride < chroma_width {
                    continue;
                }
                let mut plane = Plane {
                    data: std::slice::from_raw_parts_mut(
                        (*frame.0).data[index],
                        stride * chroma_height,
                    ),
                    stride,
                    width: chroma_width,
                    height: chroma_height,
                    channel: if index == 1 {
                        crate::overlay::Channel::Blue
                    } else {
                        crate::overlay::Channel::Red
                    },
                };
                apply(&mut plane, chroma, &overlay.kind);
            }
        }
    }

    Ok(())
}

pub(crate) struct Decoder {
    context: *mut ff::AVCodecContext,
    packet: *mut ff::AVPacket,
}

impl Decoder {
    pub(crate) fn open(track: &TrackInfo) -> Result<Self> {
        unsafe {
            let id = match track.codec {
                norisk_ipc::ClipCodec::H264 => ff::AVCodecID::AV_CODEC_ID_H264,
                norisk_ipc::ClipCodec::H265 => ff::AVCodecID::AV_CODEC_ID_HEVC,
                norisk_ipc::ClipCodec::Av1 => ff::AVCodecID::AV_CODEC_ID_AV1,
            };

            let codec = ff::avcodec_find_decoder(id);
            if codec.is_null() {
                bail!("no decoder for {:?} in this FFmpeg build", track.codec);
            }

            let context = ff::avcodec_alloc_context3(codec);
            if context.is_null() {
                bail!("avcodec_alloc_context3 failed for the video decoder");
            }

            let mut guard = Self {
                context,
                packet: std::ptr::null_mut(),
            };

            (*context).width = track.width as i32;
            (*context).height = track.height as i32;

            if !track.extradata.is_empty() {
                let size = track.extradata.len();
                let buffer =
                    ff::av_mallocz(size + ff::AV_INPUT_BUFFER_PADDING_SIZE as usize) as *mut u8;
                if buffer.is_null() {
                    bail!("could not allocate room for the stream header");
                }
                std::ptr::copy_nonoverlapping(track.extradata.as_ptr(), buffer, size);
                (*context).extradata = buffer;
                (*context).extradata_size = size as i32;
            }

            let rc = ff::avcodec_open2(context, codec, std::ptr::null_mut());
            if rc < 0 {
                bail!("opening the video decoder failed: {}", av_error(rc));
            }

            guard.packet = ff::av_packet_alloc();
            if guard.packet.is_null() {
                bail!("av_packet_alloc failed");
            }

            Ok(guard)
        }
    }

    pub(crate) fn push(&mut self, packet: &Packet) -> Result<Vec<Frame>> {
        unsafe {
            ff::av_packet_unref(self.packet);
            let rc = ff::av_new_packet(self.packet, packet.len() as i32);
            if rc < 0 {
                bail!("av_new_packet failed: {}", av_error(rc));
            }
            std::ptr::copy_nonoverlapping(
                packet.data.as_ptr(),
                (*self.packet).data,
                packet.len(),
            );
            (*self.packet).pts = packet.pts;
            (*self.packet).dts = packet.dts;
            if packet.keyframe {
                (*self.packet).flags |= ff::AV_PKT_FLAG_KEY as i32;
            }

            let rc = ff::avcodec_send_packet(self.context, self.packet);
            if rc < 0 && rc != ff::AVERROR(ff::EAGAIN) {
                bail!("avcodec_send_packet failed: {}", av_error(rc));
            }
        }
        self.drain()
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<Frame>> {
        unsafe {
            let rc = ff::avcodec_send_packet(self.context, std::ptr::null());
            if rc < 0 && rc != ff::AVERROR_EOF {
                bail!("flushing the video decoder failed: {}", av_error(rc));
            }
        }
        self.drain()
    }

    fn drain(&mut self) -> Result<Vec<Frame>> {
        let mut out = Vec::new();
        loop {
            let frame = Frame::alloc()?;
            let rc = unsafe { ff::avcodec_receive_frame(self.context, frame.0) };
            if rc == ff::AVERROR(ff::EAGAIN) || rc == ff::AVERROR_EOF {
                break;
            }
            if rc < 0 {
                bail!("avcodec_receive_frame failed: {}", av_error(rc));
            }
            out.push(frame);
        }
        Ok(out)
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe {
            ff::av_packet_free(&mut self.packet);
            ff::avcodec_free_context(&mut self.context);
        }
    }
}

pub(crate) struct Frame(pub(crate) *mut ff::AVFrame);

impl Frame {
    fn alloc() -> Result<Self> {
        let frame = unsafe { ff::av_frame_alloc() };
        if frame.is_null() {
            bail!("av_frame_alloc failed");
        }
        Ok(Self(frame))
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        unsafe { ff::av_frame_free(&mut self.0) };
    }
}

struct Encoder {
    context: *mut ff::AVCodecContext,
    packet: *mut ff::AVPacket,
    next_pts: i64,
    fps: i64,
}

impl Encoder {
    fn open(width: u32, height: u32, fps: u32) -> Result<Self> {
        unsafe {
            let name = c"libx264";
            let codec = ff::avcodec_find_encoder_by_name(name.as_ptr());
            let codec = if codec.is_null() {
                ff::avcodec_find_encoder(ff::AVCodecID::AV_CODEC_ID_H264)
            } else {
                codec
            };
            if codec.is_null() {
                bail!("no H.264 encoder in this FFmpeg build");
            }

            let context = ff::avcodec_alloc_context3(codec);
            if context.is_null() {
                bail!("avcodec_alloc_context3 failed for the video encoder");
            }

            let fps = fps.max(1) as i64;
            let mut guard = Self {
                context,
                packet: std::ptr::null_mut(),
                next_pts: 0,
                fps,
            };

            (*context).width = width as i32;
            (*context).height = height as i32;
            (*context).pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_YUV420P;
            (*context).time_base = ff::AVRational {
                num: 1,
                den: TIME_BASE_DEN as i32,
            };
            (*context).framerate = ff::AVRational {
                num: fps as i32,
                den: 1,
            };
            (*context).gop_size = (fps * 2) as i32;
            (*context).bit_rate = 8_000_000;
            (*context).color_primaries = crate::encoder::video::COLOR_PRIMARIES;
            (*context).color_trc = crate::encoder::video::COLOR_TRANSFER;
            (*context).colorspace = crate::encoder::video::COLOR_SPACE;
            (*context).color_range = crate::encoder::video::COLOR_RANGE;
            (*context).chroma_sample_location = crate::encoder::video::CHROMA_LOCATION;
            (*context).flags |= ff::AV_CODEC_FLAG_GLOBAL_HEADER as i32;
            (*context).thread_count = 0;
            if !(*context).priv_data.is_null() {
                ff::av_opt_set((*context).priv_data, c"preset".as_ptr(), c"veryfast".as_ptr(), 0);
            }

            let rc = ff::avcodec_open2(context, codec, std::ptr::null_mut());
            if rc < 0 {
                bail!("opening the H.264 encoder failed: {}", av_error(rc));
            }

            guard.packet = ff::av_packet_alloc();
            if guard.packet.is_null() {
                bail!("av_packet_alloc failed");
            }

            Ok(guard)
        }
    }

    fn extradata(&self) -> Vec<u8> {
        unsafe {
            let context = &*self.context;
            if context.extradata.is_null() || context.extradata_size <= 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(context.extradata, context.extradata_size as usize).to_vec()
        }
    }

    fn push(&mut self, frame: Frame, crop: (u32, u32, u32, u32)) -> Result<Vec<Packet>> {
        unsafe {
            let (left, right, top, bottom) = crop;
            (*frame.0).crop_left = left as usize;
            (*frame.0).crop_right = right as usize;
            (*frame.0).crop_top = top as usize;
            (*frame.0).crop_bottom = bottom as usize;

            let rc = ff::av_frame_apply_cropping(
                frame.0,
                ff::AV_FRAME_CROP_UNALIGNED as i32,
            );
            if rc < 0 {
                bail!("cropping the frame failed: {}", av_error(rc));
            }

            (*frame.0).pts = self.next_pts;
            self.next_pts += TIME_BASE_DEN as i64 / self.fps;

            let rc = ff::avcodec_send_frame(self.context, frame.0);
            if rc < 0 {
                bail!("avcodec_send_frame failed: {}", av_error(rc));
            }
        }
        self.drain()
    }

    fn finish(&mut self) -> Result<Vec<Packet>> {
        unsafe {
            let rc = ff::avcodec_send_frame(self.context, std::ptr::null());
            if rc < 0 && rc != ff::AVERROR_EOF {
                bail!("flushing the H.264 encoder failed: {}", av_error(rc));
            }
        }
        self.drain()
    }

    fn drain(&mut self) -> Result<Vec<Packet>> {
        let mut out = Vec::new();
        loop {
            let rc = unsafe { ff::avcodec_receive_packet(self.context, self.packet) };
            if rc == ff::AVERROR(ff::EAGAIN) || rc == ff::AVERROR_EOF {
                break;
            }
            if rc < 0 {
                bail!("avcodec_receive_packet failed: {}", av_error(rc));
            }

            unsafe {
                let packet = &*self.packet;
                out.push(Packet {
                    data: std::slice::from_raw_parts(packet.data, packet.size.max(0) as usize)
                        .into(),
                    pts: packet.pts,
                    dts: if packet.dts == ff::AV_NOPTS_VALUE {
                        packet.pts
                    } else {
                        packet.dts
                    },
                    keyframe: packet.flags & ff::AV_PKT_FLAG_KEY as i32 != 0,
                });
                ff::av_packet_unref(self.packet);
            }
        }
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            ff::av_packet_free(&mut self.packet);
            ff::avcodec_free_context(&mut self.context);
        }
    }
}

unsafe impl Send for Decoder {}
unsafe impl Send for Encoder {}

#[cfg(test)]
mod tests {
    use super::*;

    fn nine_by_sixteen() -> Ratio {
        norisk_ipc::ClipShape::Vertical.ratio().unwrap()
    }

    fn cropped(width: u32, height: u32) -> (u32, u32) {
        cropped_to(width, height, nine_by_sixteen())
    }

    fn cropped_to(width: u32, height: u32, ratio: Ratio) -> (u32, u32) {
        let (left, right, top, bottom) = centre_crop(width, height, ratio);
        (width - left - right, height - top - bottom)
    }

    #[test]
    fn a_landscape_clip_loses_its_sides() {
        assert_eq!(cropped(1920, 1080), (606, 1080));
        assert_eq!(cropped(2560, 1440), (810, 1440));
    }

    #[test]
    fn every_shape_cuts_to_its_own_ratio() {
        for shape in [
            norisk_ipc::ClipShape::Vertical,
            norisk_ipc::ClipShape::Square,
            norisk_ipc::ClipShape::Wide,
        ] {
            let ratio = shape.ratio().unwrap();
            for (width, height) in [(1920, 1080), (2560, 1440), (1280, 720)] {
                let (w, h) = cropped_to(width, height, ratio);
                let got = w as f64 / h as f64;
                let wanted = ratio.0 as f64 / ratio.1 as f64;
                assert!(
                    (got - wanted).abs() < 0.02,
                    "{shape:?}: {width}x{height} became {w}x{h}, ratio {got:.4} not {wanted:.4}",
                );
                assert!(w <= width && h <= height, "{shape:?} grew the picture");
            }
        }
    }

    #[test]
    fn original_keeps_the_source_size() {
        for (width, height) in [(1920, 1080), (2560, 1440), (1080, 1920), (1000, 1000)] {
            let ratio = crop_ratio(norisk_ipc::ClipShape::Original, width, height);
            assert_eq!(
                centre_crop(width, height, ratio),
                (0, 0, 0, 0),
                "{width}x{height} should lose nothing",
            );
            assert_eq!(cropped_to(width, height, ratio), (width, height));
        }
    }

    #[test]
    fn a_square_cut_of_a_wide_clip_keeps_the_full_height() {
        let (w, h) = cropped_to(1920, 1080, (1, 1));
        assert_eq!(h, 1080);
        assert_eq!(w, 1080);
    }

    #[test]
    fn what_is_left_is_nine_by_sixteen() {
        for (width, height) in [(1920, 1080), (2560, 1440), (3840, 2160), (1280, 720)] {
            let (w, h) = cropped(width, height);
            let ratio = w as f64 / h as f64;
            let wanted = nine_by_sixteen().0 as f64 / nine_by_sixteen().1 as f64;
            assert!(
                (ratio - wanted).abs() < 0.01,
                "{width}x{height} cropped to {w}x{h}, ratio {ratio:.4}",
            );
        }
    }

    #[test]
    fn the_cut_is_centred() {
        let (left, right, _, _) = centre_crop(1920, 1080, nine_by_sixteen());
        assert!(
            left.abs_diff(right) <= 2,
            "the column should sit in the middle: {left} vs {right}",
        );
    }

    #[test]
    fn every_offset_is_even() {
        for (width, height) in [(1920, 1080), (2559, 1439), (1281, 721), (3840, 2160)] {
            let (left, _, top, _) = centre_crop(width, height, nine_by_sixteen());
            assert_eq!(left % 2, 0, "{width}x{height} crops {left} from the left");
            assert_eq!(top % 2, 0, "{width}x{height} crops {top} from the top");
        }
    }

    #[test]
    fn what_is_left_has_even_sides() {
        for (width, height) in [
            (1920, 1080),
            (2560, 1440),
            (3840, 2160),
            (1280, 720),
            (2559, 1439),
            (1281, 721),
            (1080, 2400),
            (1000, 1000),
        ] {
            let (w, h) = cropped(width, height);
            assert_eq!(w % 2, 0, "{width}x{height} left a {w}-wide column");
            assert_eq!(h % 2, 0, "{width}x{height} left a {h}-tall column");
        }
    }

    #[test]
    fn a_clip_already_taller_than_wide_loses_its_top_and_bottom() {
        let (left, right, top, bottom) = centre_crop(1080, 2400, nine_by_sixteen());
        assert_eq!((left, right), (0, 0), "nothing should come off the sides");
        assert!(top > 0 && bottom > 0);

        let (w, h) = cropped(1080, 2400);
        assert_eq!(w, 1080);
        assert_eq!(h, 1920, "1080 wide at 9:16 is 1920 tall");
    }

    #[test]
    fn a_clip_already_at_the_right_shape_is_left_alone() {
        assert_eq!(centre_crop(1080, 1920, nine_by_sixteen()), (0, 0, 0, 0));
    }

    #[test]
    fn a_square_clip_loses_its_sides() {
        let (w, h) = cropped(1000, 1000);
        assert!(w < h, "a square has to become taller than it is wide: {w}x{h}");
    }
}

#[cfg(test)]
mod probe {
    #[test]
    #[ignore = "needs a real clip; run it by hand"]
    fn probe_export() {
        let Ok(source) = std::env::var("NRC_CLIP") else {
            println!("set NRC_CLIP to a clip to try this");
            return;
        };
        let destination = std::env::temp_dir().join("nrc-vertical-probe.mp4");
        let _ = std::fs::remove_file(&destination);

        let started = std::time::Instant::now();
        match super::to_vertical(std::path::Path::new(&source), &destination, norisk_ipc::ClipShape::Vertical, &[], |_, _| {}) {
            Ok(result) => println!(
                "OK  {}x{}  {:.1}s  {:.1} MB  in {} ms  -> {}",
                result.width,
                result.height,
                result.duration_seconds,
                result.size_bytes as f64 / 1e6,
                started.elapsed().as_millis(),
                result.path.display(),
            ),
            Err(e) => println!("FAILED after {} ms: {e:#}", started.elapsed().as_millis()),
        }
    }
}

#[cfg(test)]
mod render_tests {
    #[test]
    #[ignore = "needs a real clip in NRC_TEST_CLIP"]
    fn a_real_clip_takes_a_blur_an_arrow_and_some_text() {
        let source = std::path::PathBuf::from(std::env::var("NRC_TEST_CLIP").unwrap());
        let destination = std::env::temp_dir().join("nrc-overlay-test.mp4");
        let _ = std::fs::remove_file(&destination);

        let overlays = vec![
            norisk_ipc::ClipOverlay {
                kind: norisk_ipc::OverlayKind::Text {
                    content: "NORISK CLIPS".into(),
                    size: 48,
                    colour: 0xff3b30,
                },
                left: 0.08,
                top: 0.62,
                width: 0.84,
                height: 0.2,
                start_seconds: 0.0,
                end_seconds: 999.0,
            },
            norisk_ipc::ClipOverlay {
                kind: norisk_ipc::OverlayKind::Arrow {
                    colour: 0xff3b30,
                    thickness: 9,
                    towards: norisk_ipc::Corner::BottomRight,
                },
                left: 0.55,
                top: 0.12,
                width: 0.3,
                height: 0.3,
                start_seconds: 0.0,
                end_seconds: 999.0,
            },
            norisk_ipc::ClipOverlay {
            kind: norisk_ipc::OverlayKind::Blur { strength: 12 },
            left: 0.0,
            top: 0.0,
            width: 0.45,
            height: 0.22,
            start_seconds: 0.0,
            end_seconds: 999.0,
        }];

        let result = super::to_vertical(
            &source,
            &destination,
            norisk_ipc::ClipShape::Square,
            &overlays,
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.width, result.height, "a square export was not square");
        println!(
            "{}x{}  {:.1}s  {:.1} MB  -> {}",
            result.width,
            result.height,
            result.duration_seconds,
            result.size_bytes as f64 / 1e6,
            destination.display(),
        );
    }
}
