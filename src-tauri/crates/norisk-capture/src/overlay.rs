use norisk_ipc::{ClipOverlay, Corner, OverlayKind};

const BLUR_PASSES: usize = 3;

const FONT: &[u8] = include_bytes!("../../../../public/fonts/smallcaps.ttf");
const NEUTRAL: u8 = 128;

static PARSED: std::sync::OnceLock<Option<ab_glyph::FontRef<'static>>> =
    std::sync::OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Luma,
    Chroma,
}

pub struct Plane<'a> {
    pub data: &'a mut [u8],
    pub stride: usize,
    pub width: usize,
    pub height: usize,
    pub channel: Channel,
}

impl Plane<'_> {
    fn shade_for(&self, wanted: u8) -> u8 {
        match self.channel {
            Channel::Luma => wanted,
            Channel::Chroma => NEUTRAL,
        }
    }

    fn scale(&self) -> f32 {
        match self.channel {
            Channel::Luma => 1.0,
            Channel::Chroma => 0.5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: usize,
    pub top: usize,
    pub width: usize,
    pub height: usize,
}

pub fn covers(overlay: &ClipOverlay, seconds: f64) -> bool {
    seconds >= overlay.start_seconds && seconds < overlay.end_seconds
}

pub fn rect_in(overlay: &ClipOverlay, width: usize, height: usize) -> Option<Rect> {
    if width == 0 || height == 0 {
        return None;
    }

    let clamp = |value: f32| value.clamp(0.0, 1.0) as f64;
    let left = (clamp(overlay.left) * width as f64).floor() as usize;
    let top = (clamp(overlay.top) * height as f64).floor() as usize;
    let right = ((clamp(overlay.left) + clamp(overlay.width)) * width as f64).ceil() as usize;
    let bottom = ((clamp(overlay.top) + clamp(overlay.height)) * height as f64).ceil() as usize;

    let right = right.min(width);
    let bottom = bottom.min(height);
    if right <= left || bottom <= top {
        return None;
    }

    Some(Rect {
        left,
        top,
        width: right - left,
        height: bottom - top,
    })
}

pub fn apply(plane: &mut Plane, rect: Rect, kind: &OverlayKind) {
    let Some(rect) = clamp(rect, plane.width, plane.height) else {
        return;
    };
    match kind {
        OverlayKind::Blur { strength } => blur(plane, rect, *strength),
        OverlayKind::Box { shade } => fill(plane, rect, *shade),
        OverlayKind::Arrow {
            shade,
            thickness,
            towards,
        } => arrow(plane, rect, *shade, *thickness, *towards),
        OverlayKind::Text {
            content,
            size,
            shade,
        } => text(plane, rect, content, *size, *shade),
    }
}

fn fill(plane: &mut Plane, rect: Rect, shade: u8) {
    let shade = plane.shade_for(shade);
    for y in rect.top..rect.top + rect.height {
        let start = y * plane.stride + rect.left;
        plane.data[start..start + rect.width].fill(shade);
    }
}

fn text(plane: &mut Plane, rect: Rect, content: &str, size: u32, shade: u8) {
    use ab_glyph::{Font, ScaleFont};

    let Some(font) = PARSED
        .get_or_init(|| ab_glyph::FontRef::try_from_slice(FONT).ok())
        .as_ref()
    else {
        log::error!("The bundled font could not be read, so text overlays are skipped");
        return;
    };

    let content = content.trim();
    if content.is_empty() {
        return;
    }

    let shade = plane.shade_for(shade);
    let scaled = font.as_scaled(ab_glyph::PxScale::from(
        (size.clamp(4, 512) as f32 * plane.scale()).max(1.0),
    ));
    let line_height = scaled.height() + scaled.line_gap();

    let mut pen_x = 0.0f32;
    let mut baseline = scaled.ascent();

    for character in content.chars() {
        if character == '\n' {
            pen_x = 0.0;
            baseline += line_height;
            continue;
        }

        let glyph_id = font.glyph_id(character);
        let advance = scaled.h_advance(glyph_id);

        if pen_x + advance > rect.width as f32 && pen_x > 0.0 {
            pen_x = 0.0;
            baseline += line_height;
        }
        if baseline - scaled.descent() > rect.height as f32 {
            break;
        }

        let glyph = glyph_id.with_scale_and_position(
            scaled.scale(),
            ab_glyph::point(pen_x, baseline),
        );
        if let Some(outline) = font.outline_glyph(glyph) {
            let bounds = outline.px_bounds();
            outline.draw(|x, y, coverage| {
                let at_x = bounds.min.x as i64 + x as i64;
                let at_y = bounds.min.y as i64 + y as i64;
                if at_x < 0 || at_y < 0 {
                    return;
                }
                let (at_x, at_y) = (at_x as usize, at_y as usize);
                if at_x >= rect.width || at_y >= rect.height {
                    return;
                }
                let slot = (rect.top + at_y) * plane.stride + rect.left + at_x;
                let was = plane.data[slot] as f32;
                let coverage = coverage.clamp(0.0, 1.0);
                plane.data[slot] = (was + (shade as f32 - was) * coverage).round() as u8;
            });
        }

        pen_x += advance;
    }
}

fn arrow(plane: &mut Plane, rect: Rect, shade: u8, thickness: u32, towards: Corner) {
    let shade = plane.shade_for(shade);
    let thickness = (thickness.max(1) as usize).min(rect.width.min(rect.height));
    let (width, height) = (rect.width as f64, rect.height as f64);

    let flip_x = matches!(towards, Corner::TopLeft | Corner::BottomLeft);
    let flip_y = matches!(towards, Corner::TopLeft | Corner::TopRight);

    let half = thickness as f64 / 2.0;
    let head = (width.min(height) / 3.0).max(thickness as f64);

    for y in 0..rect.height {
        for x in 0..rect.width {
            let along_x = if flip_x { width - 1.0 - x as f64 } else { x as f64 };
            let along_y = if flip_y { height - 1.0 - y as f64 } else { y as f64 };

            let on_shaft = {
                let wanted = along_x * (height - 1.0).max(1.0) / (width - 1.0).max(1.0);
                (along_y - wanted).abs() <= half
            };
            let in_head = along_x >= width - head && along_y >= height - head;

            if on_shaft || in_head {
                plane.data[(rect.top + y) * plane.stride + rect.left + x] = shade;
            }
        }
    }
}

fn clamp(rect: Rect, width: usize, height: usize) -> Option<Rect> {
    let left = rect.left.min(width);
    let top = rect.top.min(height);
    let right = (rect.left + rect.width).min(width);
    let bottom = (rect.top + rect.height).min(height);
    if right <= left || bottom <= top {
        return None;
    }
    Some(Rect {
        left,
        top,
        width: right - left,
        height: bottom - top,
    })
}

fn blur(plane: &mut Plane, rect: Rect, strength: u32) {
    let radius = strength.clamp(1, 64) as usize;
    if rect.width == 0 || rect.height == 0 {
        return;
    }

    let mut row = vec![0u8; rect.width];
    for _ in 0..BLUR_PASSES {
        for y in rect.top..rect.top + rect.height {
            let start = y * plane.stride + rect.left;
            row.copy_from_slice(&plane.data[start..start + rect.width]);
            for x in 0..rect.width {
                let from = x.saturating_sub(radius);
                let to = (x + radius + 1).min(rect.width);
                let sum: u32 = row[from..to].iter().map(|v| *v as u32).sum();
                plane.data[start + x] = (sum / (to - from) as u32) as u8;
            }
        }

        let mut column = vec![0u8; rect.height];
        for x in rect.left..rect.left + rect.width {
            for (index, slot) in column.iter_mut().enumerate() {
                *slot = plane.data[(rect.top + index) * plane.stride + x];
            }
            for y in 0..rect.height {
                let from = y.saturating_sub(radius);
                let to = (y + radius + 1).min(rect.height);
                let sum: u32 = column[from..to].iter().map(|v| *v as u32).sum();
                plane.data[(rect.top + y) * plane.stride + x] = (sum / (to - from) as u32) as u8;
            }
        }
    }
}

pub fn halve(rect: Rect) -> Rect {
    Rect {
        left: rect.left / 2,
        top: rect.top / 2,
        width: (rect.width / 2).max(1),
        height: (rect.height / 2).max(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay(left: f32, top: f32, width: f32, height: f32) -> ClipOverlay {
        ClipOverlay {
            kind: OverlayKind::Blur { strength: 8 },
            left,
            top,
            width,
            height,
            start_seconds: 1.0,
            end_seconds: 3.0,
        }
    }

    fn checkerboard(width: usize, height: usize) -> Vec<u8> {
        (0..width * height)
            .map(|i| if (i / 4 + i / (width * 4)) % 2 == 0 { 20 } else { 235 })
            .collect()
    }

    fn spread(data: &[u8], stride: usize, rect: Rect) -> f64 {
        let mut values = Vec::new();
        for y in rect.top..rect.top + rect.height {
            for x in rect.left..rect.left + rect.width {
                values.push(data[y * stride + x] as f64);
            }
        }
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
    }

    #[test]
    fn an_overlay_only_covers_its_own_stretch_of_time() {
        let one = overlay(0.0, 0.0, 1.0, 1.0);
        assert!(!covers(&one, 0.99));
        assert!(covers(&one, 1.0));
        assert!(covers(&one, 2.5));
        assert!(!covers(&one, 3.0), "the end is exclusive");
        assert!(!covers(&one, 9.0));
    }

    #[test]
    fn a_fraction_of_the_frame_becomes_whole_pixels() {
        let rect = rect_in(&overlay(0.25, 0.5, 0.5, 0.25), 1920, 1080).unwrap();
        assert_eq!(rect.left, 480);
        assert_eq!(rect.top, 540);
        assert_eq!(rect.width, 960);
        assert_eq!(rect.height, 270);
    }

    #[test]
    fn an_overlay_hanging_over_the_edge_is_cut_to_the_frame() {
        let rect = rect_in(&overlay(0.8, 0.8, 0.5, 0.5), 100, 100).unwrap();
        assert_eq!(rect.left, 80);
        assert_eq!(rect.top, 80);
        assert_eq!(rect.left + rect.width, 100);
        assert_eq!(rect.top + rect.height, 100);
    }

    #[test]
    fn an_empty_or_backwards_overlay_is_dropped() {
        assert!(rect_in(&overlay(0.5, 0.5, 0.0, 0.5), 100, 100).is_none());
        assert!(rect_in(&overlay(0.5, 0.5, 0.5, 0.0), 100, 100).is_none());
        assert!(rect_in(&overlay(0.2, 0.2, 0.5, 0.5), 0, 100).is_none());
    }

    #[test]
    fn blurring_flattens_the_detail_it_covers() {
        let (width, height) = (64, 64);
        let mut data = checkerboard(width, height);
        let rect = Rect { left: 16, top: 16, width: 32, height: 32 };

        let before = spread(&data, width, rect);
        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 6 });
        let after = spread(&data, width, rect);

        assert!(
            after < before / 4.0,
            "detail survived: {before:.1} before, {after:.1} after",
        );
    }

    #[test]
    fn blurring_leaves_everything_outside_the_rectangle_alone() {
        let (width, height) = (64, 64);
        let original = checkerboard(width, height);
        let mut data = original.clone();
        let rect = Rect { left: 16, top: 16, width: 32, height: 32 };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 6 });

        for y in 0..height {
            for x in 0..width {
                let inside = x >= rect.left
                    && x < rect.left + rect.width
                    && y >= rect.top
                    && y < rect.top + rect.height;
                if !inside {
                    assert_eq!(
                        data[y * width + x],
                        original[y * width + x],
                        "pixel {x},{y} outside the rectangle changed",
                    );
                }
            }
        }
    }

    #[test]
    fn blurring_reads_rows_at_the_stride_not_the_width() {
        let (width, height, stride) = (32, 32, 48);
        let mut data = vec![7u8; stride * height];
        for y in 0..height {
            for x in 0..width {
                data[y * stride + x] = if x % 2 == 0 { 0 } else { 255 };
            }
        }

        let rect = Rect { left: 4, top: 4, width: 16, height: 16 };
        let mut plane = Plane { data: &mut data, stride, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 4 });

        for y in 0..height {
            for x in width..stride {
                assert_eq!(data[y * stride + x], 7, "padding at {x},{y} was touched");
            }
        }
    }

    #[test]
    fn a_blurred_average_stays_inside_the_range_it_came_from() {
        let (width, height) = (32, 32);
        let mut data = vec![0u8; width * height];
        for value in data.iter_mut() {
            *value = 200;
        }
        let rect = Rect { left: 0, top: 0, width, height };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 10 });

        assert!(data.iter().all(|v| *v == 200), "a flat area changed value");
    }

    #[test]
    fn a_box_paints_its_rectangle_flat_and_nothing_else() {
        let (width, height) = (32, 32);
        let original = checkerboard(width, height);
        let mut data = original.clone();
        let rect = Rect { left: 8, top: 8, width: 10, height: 6 };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Box { shade: 16 });

        for y in rect.top..rect.top + rect.height {
            for x in rect.left..rect.left + rect.width {
                assert_eq!(data[y * width + x], 16, "pixel {x},{y} was not filled");
            }
        }
        assert_eq!(data[0], original[0], "a pixel outside the box changed");
        assert_eq!(data[width * 31 + 31], original[width * 31 + 31]);
    }

    #[test]
    fn a_box_stays_inside_a_padded_plane() {
        let (width, height, stride) = (16, 16, 24);
        let mut data = vec![9u8; stride * height];
        let rect = Rect { left: 2, top: 2, width: 12, height: 12 };

        let mut plane = Plane { data: &mut data, stride, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Box { shade: 100 });

        for y in 0..height {
            for x in width..stride {
                assert_eq!(data[y * stride + x], 9, "padding at {x},{y} was filled");
            }
        }
    }

    #[test]
    fn an_arrow_marks_both_of_its_ends() {
        let (width, height) = (48, 48);
        let mut data = vec![0u8; width * height];
        let rect = Rect { left: 0, top: 0, width, height };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(
            &mut plane,
            rect,
            &OverlayKind::Arrow { shade: 255, thickness: 3, towards: Corner::BottomRight },
        );

        assert_eq!(data[0], 255, "the tail corner is empty");
        assert_eq!(data[width * (height - 1) + width - 1], 255, "the head is empty");
        assert_eq!(data[width - 1], 0, "the opposite corner should stay clear");
    }

    #[test]
    fn an_arrow_points_where_it_is_told() {
        let (width, height) = (48, 48);
        let corners = [
            (Corner::BottomRight, width * (height - 1) + width - 1),
            (Corner::BottomLeft, width * (height - 1)),
            (Corner::TopRight, width - 1),
            (Corner::TopLeft, 0),
        ];

        for (towards, head) in corners {
            let mut data = vec![0u8; width * height];
            let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
            apply(
                &mut plane,
                Rect { left: 0, top: 0, width, height },
                &OverlayKind::Arrow { shade: 255, thickness: 3, towards },
            );
            assert_eq!(data[head], 255, "{towards:?} did not reach its corner");
        }
    }

    #[test]
    fn an_arrow_never_writes_outside_its_rectangle() {
        let (width, height) = (40, 40);
        let original = vec![5u8; width * height];
        let mut data = original.clone();
        let rect = Rect { left: 10, top: 10, width: 20, height: 20 };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(
            &mut plane,
            rect,
            &OverlayKind::Arrow { shade: 200, thickness: 5, towards: Corner::TopLeft },
        );

        for y in 0..height {
            for x in 0..width {
                let inside = x >= rect.left
                    && x < rect.left + rect.width
                    && y >= rect.top
                    && y < rect.top + rect.height;
                if !inside {
                    assert_eq!(data[y * width + x], 5, "pixel {x},{y} outside was written");
                }
            }
        }
    }

    #[test]
    fn a_box_on_a_colour_plane_goes_neutral_instead_of_tinting() {
        let (width, height) = (16, 16);
        let mut data = vec![90u8; width * height];
        let rect = Rect { left: 0, top: 0, width, height };

        let mut plane = Plane {
            data: &mut data,
            stride: width,
            width,
            height,
            channel: Channel::Chroma,
        };
        apply(&mut plane, rect, &OverlayKind::Box { shade: 16 });

        assert!(
            data.iter().all(|v| *v == NEUTRAL),
            "a black box tinted the picture instead of staying grey",
        );
    }

    #[test]
    fn an_arrow_on_a_colour_plane_goes_neutral_too() {
        let (width, height) = (24, 24);
        let mut data = vec![90u8; width * height];
        let rect = Rect { left: 0, top: 0, width, height };

        let mut plane = Plane {
            data: &mut data,
            stride: width,
            width,
            height,
            channel: Channel::Chroma,
        };
        apply(
            &mut plane,
            rect,
            &OverlayKind::Arrow { shade: 235, thickness: 3, towards: Corner::BottomRight },
        );

        assert!(
            data.iter().all(|v| *v == 90 || *v == NEUTRAL),
            "the arrow wrote a colour value onto a colour plane",
        );
        assert!(data.iter().any(|v| *v == NEUTRAL), "the arrow drew nothing");
    }

    #[test]
    fn text_marks_the_picture_and_stays_in_its_box() {
        let (width, height) = (200, 80);
        let original = vec![40u8; width * height];
        let mut data = original.clone();
        let rect = Rect { left: 10, top: 10, width: 150, height: 50 };

        let mut plane = Plane {
            data: &mut data,
            stride: width,
            width,
            height,
            channel: Channel::Luma,
        };
        apply(
            &mut plane,
            rect,
            &OverlayKind::Text { content: "HALLO".into(), size: 32, shade: 235 },
        );

        let changed = data.iter().zip(&original).filter(|(a, b)| a != b).count();
        assert!(changed > 50, "text drew almost nothing ({changed} pixels)");

        for y in 0..height {
            for x in 0..width {
                let inside = x >= rect.left
                    && x < rect.left + rect.width
                    && y >= rect.top
                    && y < rect.top + rect.height;
                if !inside {
                    assert_eq!(
                        data[y * width + x],
                        original[y * width + x],
                        "text spilled outside its box at {x},{y}",
                    );
                }
            }
        }
    }

    #[test]
    fn empty_text_changes_nothing() {
        let (width, height) = (64, 32);
        let original = vec![40u8; width * height];
        let mut data = original.clone();

        let mut plane = Plane {
            data: &mut data,
            stride: width,
            width,
            height,
            channel: Channel::Luma,
        };
        apply(
            &mut plane,
            Rect { left: 0, top: 0, width, height },
            &OverlayKind::Text { content: "   ".into(), size: 20, shade: 235 },
        );

        assert_eq!(data, original);
    }

    #[test]
    fn the_bundled_font_can_actually_be_read() {
        assert!(
            PARSED
                .get_or_init(|| ab_glyph::FontRef::try_from_slice(FONT).ok())
                .is_some(),
            "the font shipped with the engine did not parse",
        );
    }

    #[test]
    fn chroma_planes_get_the_matching_half_sized_rectangle() {
        let rect = Rect { left: 480, top: 540, width: 960, height: 270 };
        let chroma = halve(rect);
        assert_eq!(chroma, Rect { left: 240, top: 270, width: 480, height: 135 });
    }

    #[test]
    fn a_rectangle_reaching_past_the_plane_is_cut_to_it_instead_of_panicking() {
        let (width, height) = (32, 32);
        let mut data = checkerboard(width, height);
        let rect = Rect { left: 24, top: 24, width: 99, height: 99 };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 4 });

        assert_eq!(data.len(), width * height);
    }

    #[test]
    fn a_rectangle_wholly_outside_the_plane_does_nothing() {
        let (width, height) = (32, 32);
        let original = checkerboard(width, height);
        let mut data = original.clone();
        let rect = Rect { left: 40, top: 40, width: 8, height: 8 };

        let mut plane = Plane { data: &mut data, stride: width, width, height, channel: Channel::Luma };
        apply(&mut plane, rect, &OverlayKind::Blur { strength: 4 });

        assert_eq!(data, original);
    }

    #[test]
    fn a_thin_rectangle_never_halves_away_to_nothing() {
        let chroma = halve(Rect { left: 0, top: 0, width: 1, height: 1 });
        assert!(chroma.width >= 1 && chroma.height >= 1);
    }
}
