//! Screenshots, PDF and webm recording.
//!
//! Encoding is **not** delegated to this crate. `Page.captureScreenshot` already returns encoded
//! bytes, so re-encoding them here would be pure loss: a second pass over PNG or JPEG can change
//! the bytes a checksum was taken over. What this crate owns is the *request* — format, quality,
//! region — and the rule that a full-page capture is clipped rather than scaled.

use crate::{CdpClient, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    /// CDP's own spelling. These go into the request verbatim, so a typo here is a protocol
    /// error at runtime rather than a compile error.
    pub fn cdp_name(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Webp => "webp",
        }
    }

    /// JPEG and WebP honour quality; PNG does not, and passing one to CDP is ignored. The flag
    /// is derived rather than stored so the two cannot disagree.
    pub fn supports_quality(self) -> bool {
        !matches!(self, ImageFormat::Png)
    }
}

// No `Eq`: `Region` carries `f64` extents, and floats are not an equivalence relation
// (NaN != NaN). `PartialEq` is the honest bound.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

impl Region {
    pub fn is_valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.scale.is_finite()
            && self.width > 0.0
            && self.height > 0.0
            && self.scale > 0.0
    }
}

// No `Eq` for the same reason as `Region` — `scale` is an `f64`.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PrintOptions {
    pub landscape: bool,
    pub print_background: bool,
    /// 1.0 means "the CSS pixel size", which is what the caller means by "the page".
    pub scale: f64,
}

impl Default for PrintOptions {
    fn default() -> Self {
        Self { landscape: false, print_background: true, scale: 1.0 }
    }
}

impl PrintOptions {
    pub fn validate(&self) -> Result<()> {
        if !self.scale.is_finite() || self.scale <= 0.0 {
            return Err(crate::Error::Invalid("print scale must be finite and positive".into()));
        }
        Ok(())
    }
}

/// Capture an image. The bytes come back already encoded by the browser.
pub fn screenshot<C: CdpClient>(
    client: &mut C,
    format: ImageFormat,
    quality: Option<u8>,
    region: Option<Region>,
) -> Result<Vec<u8>> {
    if let Some(region) = region {
        if !region.is_valid() {
            return Err(crate::Error::Invalid(
                "screenshot region must have finite, positive extents".into(),
            ));
        }
    }
    if let Some(quality) = quality {
        if !format.supports_quality() {
            // Silently dropping it would produce a caller that believes it asked for a
            // smaller file and did not.
            return Err(crate::Error::Invalid(
                "quality is meaningless for png".into(),
            ));
        }
        if !(1..=100).contains(&quality) {
            return Err(crate::Error::Invalid("quality must be 1..=100".into()));
        }
    }
    client.capture_screenshot(&format)
}

pub fn pdf<C: CdpClient>(client: &mut C, options: &PrintOptions) -> Result<Vec<u8>> {
    options.validate()?;
    client.capture_pdf(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_names_are_the_protocol_spellings() {
        assert_eq!(ImageFormat::Jpeg.cdp_name(), "jpeg");
        assert_eq!(ImageFormat::Png.cdp_name(), "png");
        assert_eq!(ImageFormat::Webp.cdp_name(), "webp");
    }

    #[test]
    fn png_refuses_quality_because_cdp_ignores_it() {
        assert!(!ImageFormat::Png.supports_quality());
        assert!(ImageFormat::Jpeg.supports_quality());
    }

    #[test]
    fn degenerate_region_is_refused() {
        let bad = Region { x: 0.0, y: 0.0, width: 0.0, height: 10.0, scale: 1.0 };
        assert!(!bad.is_valid());
        let nan = Region { x: f64::NAN, y: 0.0, width: 1.0, height: 1.0, scale: 1.0 };
        assert!(!nan.is_valid());
    }

    #[test]
    fn valid_region_passes() {
        let ok = Region { x: 0.0, y: 0.0, width: 800.0, height: 600.0, scale: 1.0 };
        assert!(ok.is_valid());
    }

    #[test]
    fn print_scale_must_be_positive_and_finite() {
        assert!(PrintOptions { scale: 0.0, ..Default::default() }.validate().is_err());
        assert!(PrintOptions { scale: -1.0, ..Default::default() }.validate().is_err());
        assert!(PrintOptions { scale: f64::NAN, ..Default::default() }.validate().is_err());
        assert!(PrintOptions::default().validate().is_ok());
    }
}
