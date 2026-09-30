// zcode-image: native image prepare/resize (decode + resize + encode ladder).
// Spec: docs/specs/rust-native-image.md. The full candidate ladder from the
// deleted TS implementation (apps/zcode-cli/packages/adapters/src/image/) is
// ported 1:1 — ordering, strategy names, budget math and error codes are
// contract-level identical. There is no JS fallback by design.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::codecs::gif::GifEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader};
use napi::bindgen_prelude::*;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

const JPEG_QUALITY_STEPS: [i32; 4] = [80, 60, 40, 20];
const PROGRESSIVE_SCALE_FACTORS: [f64; 3] = [0.75, 0.5, 0.25];
const AGGRESSIVE_JPEG_MAX_EDGES: [u32; 6] = [1000, 800, 600, 400, 300, 200];
const MIN_IMAGE_EDGE: u32 = 1;
const JIMP_DEFAULT_JPEG_QUALITY: i32 = 80;

const STRATEGY_ORIGINAL: &str = "original";
const STRATEGY_PRESERVE_FORMAT: &str = "preserve-format";
const STRATEGY_PNG_OPTIMIZED: &str = "png-optimized";
const STRATEGY_RESIZED: &str = "resized";
const STRATEGY_JPEG_QUALITY: &str = "jpeg-quality";
const STRATEGY_JPEG_FALLBACK: &str = "jpeg-fallback";

const ERR_ABORTED: &str = "Image resize was cancelled";

#[napi]
pub struct ImageCancelHandle {
  flag: Arc<AtomicBool>,
}

#[napi]
impl ImageCancelHandle {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      flag: Arc::new(AtomicBool::new(false)),
    }
  }

  #[napi]
  pub fn cancel(&self) {
    self.flag.store(true, Ordering::SeqCst);
  }

  #[allow(dead_code)]
  fn is_cancelled(&self) -> bool {
    self.flag.load(Ordering::SeqCst)
  }
}

fn native_error(code: &str, message: impl AsRef<str>) -> Error {
  Error::new(
    Status::GenericFailure,
    format!("zcode-image:{}:{}", code, message.as_ref()),
  )
}

fn throw_if_cancelled(flag: &AtomicBool) -> Result<()> {
  if flag.load(Ordering::SeqCst) {
    return Err(native_error("aborted", ERR_ABORTED));
  }
  Ok(())
}

fn detect_media_type(data: &[u8]) -> Option<&'static str> {
  if data.len() >= 4 && data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47 {
    return Some("image/png");
  }
  if data.len() >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
    return Some("image/jpeg");
  }
  if data.len() >= 3 && data[0] == 0x47 && data[1] == 0x49 && data[2] == 0x46 {
    return Some("image/gif");
  }
  if data.len() >= 12
    && data[0] == 0x52
    && data[1] == 0x49
    && data[2] == 0x46
    && data[3] == 0x46
    && data[8] == 0x57
    && data[9] == 0x45
    && data[10] == 0x42
    && data[11] == 0x50
  {
    return Some("image/webp");
  }
  None
}

fn normalize_media_type(value: &str) -> &'static str {
  match value.to_ascii_lowercase().as_str() {
    "image/jpg" | "image/jpeg" => "image/jpeg",
    "image/gif" => "image/gif",
    "image/webp" => "image/webp",
    // Mirrors the legacy normalizeMediaType: unknown types fall back to PNG.
    _ => "image/png",
  }
}

fn is_output_mime(value: &str) -> bool {
  matches!(
    value,
    "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/tiff"
  )
}

fn output_media_type(requested: &str, detected: Option<&str>) -> &'static str {
  if is_output_mime(requested) {
    return normalize_output_mime(requested).unwrap_or("image/png");
  }
  if let Some(detected) = detected {
    if is_output_mime(detected) {
      return normalize_output_mime(detected).unwrap_or("image/png");
    }
  }
  "image/png"
}

fn normalize_output_mime(value: &str) -> Option<&'static str> {
  match value {
    "image/bmp" => Some("image/bmp"),
    "image/gif" => Some("image/gif"),
    "image/jpeg" => Some("image/jpeg"),
    "image/png" => Some("image/png"),
    "image/tiff" => Some("image/tiff"),
    _ => None,
  }
}

fn normalize_detected(value: &str) -> &'static str {
  match value {
    "image/png" => "image/png",
    "image/jpeg" => "image/jpeg",
    "image/gif" => "image/gif",
    _ => "image/webp",
  }
}

#[napi(object)]
pub struct ImagePrepareRequest {
  pub data: Buffer,
  pub media_type: String,
  pub max_dimension: f64,
  pub max_base64_bytes: f64,
  pub max_raw_bytes: f64,
  pub max_tokens: Option<f64>,
  pub token_to_base64_char_ratio: Option<f64>,
}

#[napi(object)]
pub struct ImageResizeToFitRequest {
  pub data: Buffer,
  pub media_type: String,
  pub max_dimension: f64,
}

#[napi(object)]
pub struct ImageResizeResult {
  pub data: Buffer,
  pub media_type: String,
  pub original_width: Option<u32>,
  pub original_height: Option<u32>,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub resized: bool,
}

#[napi(object)]
pub struct ImagePrepareResult {
  pub data: Buffer,
  pub media_type: String,
  pub original_width: Option<u32>,
  pub original_height: Option<u32>,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub resized: bool,
  pub compressed: bool,
  pub strategy: String,
  pub original_size_bytes: f64,
  pub transformed_size_bytes: f64,
}

struct Budget {
  max_base64_bytes: f64,
  max_raw_bytes: f64,
  max_tokens: Option<f64>,
  token_to_base64_char_ratio: f64,
}

impl Budget {
  fn validate_and_build(
    max_dimension: f64,
    max_base64_bytes: f64,
    max_raw_bytes: f64,
    max_tokens: Option<f64>,
    token_to_base64_char_ratio: Option<f64>,
  ) -> Result<Self> {
    if !max_dimension.is_finite() || max_dimension <= 0.0 {
      return Err(native_error(
        "invalid_request",
        "Image resize maxDimension must be a positive finite number",
      ));
    }
    if !max_base64_bytes.is_finite() || max_base64_bytes <= 0.0 {
      return Err(native_error(
        "invalid_request",
        "Image maxBase64Bytes must be a positive finite number",
      ));
    }
    if !max_raw_bytes.is_finite() || max_raw_bytes <= 0.0 {
      return Err(native_error(
        "invalid_request",
        "Image maxRawBytes must be a positive finite number",
      ));
    }
    Ok(Budget {
      max_base64_bytes: max_base64_bytes.floor(),
      max_raw_bytes: max_raw_bytes.floor(),
      max_tokens,
      token_to_base64_char_ratio: token_to_base64_char_ratio.unwrap_or(0.125),
    })
  }

  // Mirrors fitsImageBudget: raw limit, base64 limit, then optional token limit.
  fn fits(&self, byte_length: usize) -> bool {
    let base64_bytes = ((byte_length as f64) / 3.0).ceil() * 4.0;
    if (byte_length as f64) > self.max_raw_bytes {
      return false;
    }
    if base64_bytes > self.max_base64_bytes {
      return false;
    }
    match self.max_tokens {
      None => true,
      Some(max_tokens) => (base64_bytes * self.token_to_base64_char_ratio).ceil() <= max_tokens,
    }
  }
}

struct Candidate {
  data: Vec<u8>,
  media_type: &'static str,
  strategy: &'static str,
  width: u32,
  height: u32,
}

// Encoders return this marker so every codec failure maps to processing_failed.
struct EncodeFail;

impl From<image::ImageError> for EncodeFail {
  fn from(_: image::ImageError) -> Self {
    EncodeFail
  }
}

impl From<std::io::Error> for EncodeFail {
  fn from(_: std::io::Error) -> Self {
    EncodeFail
  }
}

fn decode(data: &[u8]) -> std::result::Result<image::DynamicImage, EncodeFail> {
  Ok(ImageReader::new(std::io::Cursor::new(data))
    .with_guessed_format()?
    .decode()?)
}

fn longest_edge(image: &image::DynamicImage) -> u32 {
  image.width().max(image.height())
}

// Mirrors Jimp scaleToFit: fit inside max_edge x max_edge, aspect preserved,
// bicubic (CatmullRom) resampling. Returns a clone when already within bounds.
fn resize_to_max_edge(image: &image::DynamicImage, max_edge: u32) -> image::DynamicImage {
  if longest_edge(image) <= max_edge {
    return image.clone();
  }
  image.resize(max_edge, max_edge, image::imageops::FilterType::CatmullRom)
}

fn encode_png(image: &image::DynamicImage) -> std::result::Result<Vec<u8>, EncodeFail> {
  let mut out = Vec::new();
  let encoder = PngEncoder::new_with_quality(
    std::io::Cursor::new(&mut out),
    CompressionType::Best,
    PngFilterType::Adaptive,
  );
  let rgba = image.to_rgba8();
  encoder.write_image(
    rgba.as_raw(),
    rgba.width(),
    rgba.height(),
    ExtendedColorType::Rgba8,
  )?;
  Ok(out)
}

fn encode_jpeg(
  image: &image::DynamicImage,
  quality: i32,
) -> std::result::Result<Vec<u8>, EncodeFail> {
  let rgb = image.to_rgb8();
  let mut encoder = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
  encoder.set_size(rgb.width() as usize, rgb.height() as usize);
  encoder.set_quality(quality as f32);
  let mut started = encoder
    .start_compress(Vec::new())
    .map_err(|_| EncodeFail)?;
  started
    .write_scanlines(rgb.as_raw())
    .map_err(|_| EncodeFail)?;
  started.finish().map_err(|_| EncodeFail)
}

fn encode_gif(image: &image::DynamicImage) -> std::result::Result<Vec<u8>, EncodeFail> {
  let mut out = Vec::new();
  let mut encoder = GifEncoder::new(std::io::Cursor::new(&mut out));
  encoder.encode_frame(image::Frame::new(image.to_rgba8()))?;
  drop(encoder);
  Ok(out)
}

fn encode_output(
  image: &image::DynamicImage,
  media_type: &str,
  jpeg_quality: Option<i32>,
) -> std::result::Result<(Vec<u8>, &'static str), EncodeFail> {
  match (media_type, jpeg_quality) {
    ("image/jpeg", Some(quality)) => Ok((encode_jpeg(image, quality)?, "image/jpeg")),
    ("image/jpeg", None) => Ok((
      encode_jpeg(image, JIMP_DEFAULT_JPEG_QUALITY)?,
      "image/jpeg",
    )),
    ("image/png", _) => Ok((encode_png(image)?, "image/png")),
    ("image/gif", _) => Ok((encode_gif(image)?, "image/gif")),
    ("image/bmp", _) => {
      let mut out = Vec::new();
      image.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Bmp)?;
      Ok((out, "image/bmp"))
    }
    ("image/tiff", _) => {
      let mut out = Vec::new();
      image.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Tiff)?;
      Ok((out, "image/tiff"))
    }
    _ => Err(EncodeFail),
  }
}

fn same_dimensions(left: &image::DynamicImage, right: &image::DynamicImage) -> bool {
  left.width() == right.width() && left.height() == right.height()
}

struct Ladder<'a> {
  image: &'a image::DynamicImage,
  source_media_type: &'static str,
  budget: &'a Budget,
  max_dimension: u32,
  cancel: &'a AtomicBool,
}

impl Ladder<'_> {
  fn fit(&self, candidate: Candidate) -> Option<Candidate> {
    if self.budget.fits(candidate.data.len()) {
      Some(candidate)
    } else {
      None
    }
  }

  fn encode_candidate(
    &self,
    image: &image::DynamicImage,
    media_type: &str,
    strategy: &'static str,
    jpeg_quality: Option<i32>,
  ) -> Result<Option<Candidate>> {
    throw_if_cancelled(self.cancel)?;
    let (data, media_type) = match encode_output(image, media_type, jpeg_quality) {
      Ok(ok) => ok,
      Err(EncodeFail) => {
        return Err(native_error("processing_failed", "Unable to encode image data"))
      }
    };
    throw_if_cancelled(self.cancel)?;
    Ok(self.fit(Candidate {
      data,
      media_type,
      strategy,
      width: image.width(),
      height: image.height(),
    }))
  }

  fn jpeg_quality_candidate(&self, image: &image::DynamicImage) -> Result<Option<Candidate>> {
    for quality in JPEG_QUALITY_STEPS {
      if let Some(candidate) =
        self.encode_candidate(image, "image/jpeg", STRATEGY_JPEG_QUALITY, Some(quality))?
      {
        return Ok(Some(candidate));
      }
    }
    Ok(None)
  }

  fn format_preserving_candidate(
    &self,
    image: &image::DynamicImage,
    media_type: &str,
  ) -> Result<Option<Candidate>> {
    match media_type {
      "image/png" => self.encode_candidate(image, "image/png", STRATEGY_PNG_OPTIMIZED, None),
      "image/jpeg" => self.jpeg_quality_candidate(image),
      "image/gif" => self.encode_candidate(image, "image/gif", STRATEGY_PRESERVE_FORMAT, None),
      _ => Ok(None),
    }
  }
}

// 1:1 port of findFirstFittingCandidate — do not reorder steps without updating
// docs/specs/rust-native-image.md.
fn find_first_fitting_candidate(ladder: &Ladder) -> Result<Option<Candidate>> {
  let original_within_dimensions =
    ladder.image.width() <= ladder.max_dimension && ladder.image.height() <= ladder.max_dimension;
  // After PNG original size optimization fails, the old strategy retried PNG at
  // each zoom level, producing larger-size JPEG. PNG only gets one lossless
  // optimization at original size, then switches to JPEG exclusively.
  let preserve_source_format_after_initial_attempt = ladder.source_media_type != "image/png";

  if original_within_dimensions {
    if let Some(candidate) =
      ladder.format_preserving_candidate(ladder.image, ladder.source_media_type)?
    {
      return Ok(Some(candidate));
    }
  }

  let bounded_image = resize_to_max_edge(ladder.image, ladder.max_dimension);
  if preserve_source_format_after_initial_attempt && !same_dimensions(ladder.image, &bounded_image) {
    if let Some(candidate) = ladder.encode_candidate(
      &bounded_image,
      ladder.source_media_type,
      STRATEGY_RESIZED,
      None,
    )? {
      return Ok(Some(candidate));
    }
  }

  if !original_within_dimensions && preserve_source_format_after_initial_attempt {
    if let Some(candidate) =
      ladder.format_preserving_candidate(&bounded_image, ladder.source_media_type)?
    {
      return Ok(Some(candidate));
    }
  }

  if let Some(candidate) = ladder.jpeg_quality_candidate(&bounded_image)? {
    return Ok(Some(candidate));
  }

  for scale in PROGRESSIVE_SCALE_FACTORS {
    let target_edge =
      ((longest_edge(&bounded_image) as f64) * scale).round().max(MIN_IMAGE_EDGE as f64) as u32;
    let scaled = resize_to_max_edge(&bounded_image, target_edge);
    if preserve_source_format_after_initial_attempt {
      if let Some(candidate) =
        ladder.format_preserving_candidate(&scaled, ladder.source_media_type)?
      {
        return Ok(Some(candidate));
      }
    }
    if let Some(candidate) = ladder.jpeg_quality_candidate(&scaled)? {
      return Ok(Some(candidate));
    }
  }

  for max_edge in AGGRESSIVE_JPEG_MAX_EDGES {
    let scaled = resize_to_max_edge(ladder.image, max_edge.min(ladder.max_dimension));
    if let Some(candidate) =
      ladder.encode_candidate(&scaled, "image/jpeg", STRATEGY_JPEG_FALLBACK, Some(20))?
    {
      return Ok(Some(candidate));
    }
  }

  Ok(None)
}

fn prepare_common(
  data: Vec<u8>,
  media_type: &str,
  max_dimension: f64,
  max_base64_bytes: f64,
  max_raw_bytes: f64,
  max_tokens: Option<f64>,
  token_to_base64_char_ratio: Option<f64>,
  cancel: &AtomicBool,
) -> Result<ImagePrepareResult> {
  throw_if_cancelled(cancel)?;
  if data.is_empty() {
    return Err(native_error("empty", "Image file is empty (0 bytes)"));
  }

  let detected = detect_media_type(&data);
  let source_media_type = detected
    .map(normalize_detected)
    .unwrap_or_else(|| normalize_media_type(media_type));

  let budget =
    Budget::validate_and_build(max_dimension, max_base64_bytes, max_raw_bytes, max_tokens, token_to_base64_char_ratio)?;

  if source_media_type == "image/webp" {
    if !budget.fits(data.len()) {
      return Err(native_error(
        "unsupported",
        "WebP image exceeds the model image budget and the current image adapter cannot transcode WebP",
      ));
    }
    let len = data.len() as f64;
    return Ok(ImagePrepareResult {
      data: data.into(),
      media_type: "image/webp".to_string(),
      original_width: None,
      original_height: None,
      width: None,
      height: None,
      resized: false,
      compressed: false,
      strategy: STRATEGY_ORIGINAL.to_string(),
      original_size_bytes: len,
      transformed_size_bytes: len,
    });
  }

  let image = match decode(&data) {
    Ok(image) => image,
    Err(EncodeFail) => return Err(native_error("processing_failed", "Unable to decode image data")),
  };
  throw_if_cancelled(cancel)?;

  let original_width = image.width();
  let original_height = image.height();
  let input_len = data.len() as f64;

  if original_width as f64 <= max_dimension
    && original_height as f64 <= max_dimension
    && budget.fits(data.len())
  {
    return Ok(ImagePrepareResult {
      data: data.into(),
      media_type: source_media_type.to_string(),
      original_width: Some(original_width),
      original_height: Some(original_height),
      width: Some(original_width),
      height: Some(original_height),
      resized: false,
      compressed: false,
      strategy: STRATEGY_ORIGINAL.to_string(),
      original_size_bytes: input_len,
      transformed_size_bytes: input_len,
    });
  }

  let ladder = Ladder {
    image: &image,
    source_media_type,
    budget: &budget,
    max_dimension: max_dimension as u32,
    cancel,
  };
  let candidate = match find_first_fitting_candidate(&ladder)? {
    Some(candidate) => candidate,
    None => {
      return Err(native_error(
        "too_large",
        format!(
          "Unable to compress image ({} bytes) within the requested model image budget",
          data.len()
        ),
      ))
    }
  };

  let resized = candidate.width != original_width || candidate.height != original_height;
  let media_type = normalize_media_type(candidate.media_type);
  let transformed_size_bytes = candidate.data.len() as f64;
  let compressed = candidate.data.len() < data.len() || media_type != source_media_type;
  Ok(ImagePrepareResult {
    data: candidate.data.into(),
    media_type: media_type.to_string(),
    original_width: Some(original_width),
    original_height: Some(original_height),
    width: Some(candidate.width),
    height: Some(candidate.height),
    resized,
    compressed,
    strategy: candidate.strategy.to_string(),
    original_size_bytes: input_len,
    transformed_size_bytes,
  })
}

fn resize_to_fit_common(
  data: Vec<u8>,
  media_type: &str,
  max_dimension: f64,
  cancel: &AtomicBool,
) -> Result<ImageResizeResult> {
  throw_if_cancelled(cancel)?;
  if data.is_empty() {
    return Err(native_error("empty", "Image file is empty (0 bytes)"));
  }

  // WebP passthrough is product behavior (the runtime cannot transcode WebP).
  if detect_media_type(&data) == Some("image/webp") {
    return Ok(ImageResizeResult {
      data: data.into(),
      media_type: media_type.to_string(),
      original_width: None,
      original_height: None,
      width: None,
      height: None,
      resized: false,
    });
  }

  let image = match decode(&data) {
    Ok(image) => image,
    Err(EncodeFail) => return Err(native_error("processing_failed", "Unable to decode image data")),
  };
  throw_if_cancelled(cancel)?;

  let original_width = image.width();
  let original_height = image.height();
  if original_width as f64 <= max_dimension && original_height as f64 <= max_dimension {
    return Ok(ImageResizeResult {
      data: data.into(),
      media_type: media_type.to_string(),
      original_width: Some(original_width),
      original_height: Some(original_height),
      width: Some(original_width),
      height: Some(original_height),
      resized: false,
    });
  }

  let bounded = resize_to_max_edge(&image, max_dimension as u32);
  throw_if_cancelled(cancel)?;
  let detected = detect_media_type(&data);
  let output = output_media_type(media_type, detected);
  let out_data = match encode_output(&bounded, output, None) {
    Ok((data, _)) => data,
    Err(EncodeFail) => return Err(native_error("processing_failed", "Unable to encode image data")),
  };
  throw_if_cancelled(cancel)?;

  Ok(ImageResizeResult {
    data: out_data.into(),
    media_type: output.to_string(),
    original_width: Some(original_width),
    original_height: Some(original_height),
    width: Some(bounded.width()),
    height: Some(bounded.height()),
    resized: true,
  })
}

pub struct PrepareTask {
  data: Vec<u8>,
  media_type: String,
  max_dimension: f64,
  max_base64_bytes: f64,
  max_raw_bytes: f64,
  max_tokens: Option<f64>,
  token_to_base64_char_ratio: Option<f64>,
  cancel: Arc<AtomicBool>,
}

#[napi(object)]
pub struct PreparedOutput {
  pub data: Buffer,
  pub media_type: String,
  pub original_width: Option<u32>,
  pub original_height: Option<u32>,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub resized: bool,
  pub compressed: bool,
  pub strategy: String,
  pub original_size_bytes: f64,
  pub transformed_size_bytes: f64,
}

impl Task for PrepareTask {
  type Output = PreparedOutput;
  type JsValue = ImagePrepareResult;

  fn compute(&mut self) -> Result<Self::Output> {
    let out = prepare_common(
      self.data.clone(),
      &self.media_type,
      self.max_dimension,
      self.max_base64_bytes,
      self.max_raw_bytes,
      self.max_tokens,
      self.token_to_base64_char_ratio,
      &self.cancel,
    )?;
    Ok(PreparedOutput {
      data: out.data,
      media_type: out.media_type,
      original_width: out.original_width,
      original_height: out.original_height,
      width: out.width,
      height: out.height,
      resized: out.resized,
      compressed: out.compressed,
      strategy: out.strategy,
      original_size_bytes: out.original_size_bytes,
      transformed_size_bytes: out.transformed_size_bytes,
    })
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(ImagePrepareResult {
      data: output.data,
      media_type: output.media_type,
      original_width: output.original_width,
      original_height: output.original_height,
      width: output.width,
      height: output.height,
      resized: output.resized,
      compressed: output.compressed,
      strategy: output.strategy,
      original_size_bytes: output.original_size_bytes,
      transformed_size_bytes: output.transformed_size_bytes,
    })
  }
}

pub struct ResizeTask {
  data: Vec<u8>,
  media_type: String,
  max_dimension: f64,
  cancel: Arc<AtomicBool>,
}

impl Task for ResizeTask {
  type Output = ImageResizeResult;
  type JsValue = ImageResizeResult;

  fn compute(&mut self) -> Result<Self::Output> {
    resize_to_fit_common(
      self.data.clone(),
      &self.media_type,
      self.max_dimension,
      &self.cancel,
    )
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

#[napi]
pub fn prepare_image_for_model(
  request: ImagePrepareRequest,
  cancel: &ImageCancelHandle,
) -> Result<AsyncTask<PrepareTask>> {
  Ok(AsyncTask::new(PrepareTask {
    data: request.data.to_vec(),
    media_type: request.media_type,
    max_dimension: request.max_dimension,
    max_base64_bytes: request.max_base64_bytes,
    max_raw_bytes: request.max_raw_bytes,
    max_tokens: request.max_tokens,
    token_to_base64_char_ratio: request.token_to_base64_char_ratio,
    cancel: cancel.flag.clone(),
  }))
}

#[napi]
pub fn resize_image_to_fit(
  request: ImageResizeToFitRequest,
  cancel: &ImageCancelHandle,
) -> Result<AsyncTask<ResizeTask>> {
  Ok(AsyncTask::new(ResizeTask {
    data: request.data.to_vec(),
    media_type: request.media_type,
    max_dimension: request.max_dimension,
    cancel: cancel.flag.clone(),
  }))
}
