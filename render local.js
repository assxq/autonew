#!/usr/bin/env node
/**
 * render_local.js — 로컬 ffmpeg로 "이미지 + 나레이션 → mp4" (자막 없음)
 *
 * 슬레이트 "타임라인 내보내기" zip을 푼 폴더를 넘기면,
 * 각 컷 이미지를 음성 길이만큼 천천히 줌인(켄번즈)하고, 컷 사이를 페이드로 넘기며,
 * 해당 컷 음성을 깔아 순서대로 이어붙여 하나의 mp4를 만듭니다.
 *
 * 폴더 구조 (zip을 푼 그대로):
 *   <폴더>/images/C01.png ...
 *   <폴더>/audio/C01.mp3 ...
 *   <폴더>/timeline.json
 *
 * 사용법:
 *   node render_local.js ./박정희편_export
 *   node render_local.js ./박정희편_export out.mp4        // 출력 파일명 지정
 *
 * 사전 준비: Homebrew로 ffmpeg 설치 (brew install ffmpeg)
 *
 * 음성이 없는 컷은 timeline.json의 duration(글자수 추정)으로 길이를 잡습니다.
 */

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");

const [, , exportDir, outArg] = process.argv;
if (!exportDir) { console.error("사용법: node render_local.js <export폴더> [출력.mp4]"); process.exit(1); }

// ---- 설정 (원하면 숫자만 바꾸세요) ----
const W = 1920, H = 1080;     // 출력 해상도
const FPS = 30;               // 프레임레이트
const FADE = 0.4;             // 컷 사이 페이드 길이(초)
const ZOOM_MAX = 1.12;        // 켄번즈 줌 최대 배율 (1.0=줌없음, 1.12=12% 줌인)

// ---- 음성 묵음 제거 (무음 없는 영상의 핵심) ----
const TRIM_SILENCE = true;    // 각 음성의 앞뒤 묵음을 잘라내 컷마다 빈 시간을 없앰
const TRIM_DB = -40;          // 이 dB보다 조용하면 묵음으로 간주 (-40 권장)
const TAIL_PAD = 0.15;        // 말 끝난 뒤 이만큼(초)은 남겨 자연스럽게 (너무 0이면 말이 잘린 느낌)

// ---- 오버레이 설정 ----
const OVERLAY_DIR = "overlays";     // 파일 오버레이 폴더 (dust.mp4 등)
const OVERLAY_OPACITY = 0.5;        // 파일 오버레이 합성 강도 (0~1)
// 디자인 프리셋 → 자동 적용 오버레이 (파일 태그 + ffmpeg 자체효과)
const PRESET_OVERLAY = {
  mystery: { files: ["dust"], grain: 0.05, vignette: 0.35 },
  tragedy: { files: ["dust"], grain: 0.04, vignette: 0.40 },
  triumph: { files: ["bokeh"], grain: 0.04, vignette: 0.15 },
  numbers: { files: [],        grain: 0.03, vignette: 0.10 }
};
const DEFAULT_OVERLAY = { files: [], grain: 0.04, vignette: 0.25 };

// ---- 사전 점검 ----
function has(cmd) { try { execSync(`command -v ${cmd}`, { stdio: "ignore" }); return true; } catch { return false; } }
if (!has("ffmpeg")) { console.error("✗ ffmpeg가 없습니다. 'brew install ffmpeg' 후 다시 실행하세요."); process.exit(1); }

const tlPath = path.join(exportDir, "timeline.json");
if (!fs.existsSync(tlPath)) { console.error(`✗ timeline.json이 없습니다: ${tlPath}`); process.exit(1); }
const tl = JSON.parse(fs.readFileSync(tlPath, "utf8"));
// 파일명에 쓸 수 없는 문자 제거: / \ : * ? " < > | 쉼표·공백 등
const safeName = (tl.project || "video")
  .replace(/[\/\\:*?"<>|]/g, "")   // OS 금지 문자 제거
  .replace(/[,()]/g, "")            // 쉼표·괄호 제거
  .replace(/\s+/g, "_")             // 공백 → _
  .replace(/_+/g, "_")              // 연속 _ 정리
  .replace(/^_|_$/g, "")            // 앞뒤 _ 제거
  .slice(0, 60) || "video";
const project = safeName;
const outFile = outArg || path.join(exportDir, project + ".mp4");

const tmp = path.join(exportDir, ".render_tmp");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

// 실제 음성 길이를 ffprobe로 측정 (timeline 값보다 정확)
function probeDur(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).toString().trim();
    const d = parseFloat(out);
    return isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

// 음성 앞뒤 묵음을 잘라 새 파일로 만들고 그 경로를 반환 (실패하면 원본 경로)
function trimSilence(srcPath, idx) {
  if (!TRIM_SILENCE) return srcPath;
  const out = path.join(tmp, `aud_${String(idx).padStart(3, "0")}.m4a`);
  try {
    // 앞 묵음 제거 + (영상 뒤집어) 뒤 묵음 제거 후 다시 뒤집기 → 앞뒤 모두 트리밍
    const filter =
      `silenceremove=start_periods=1:start_silence=0:start_threshold=${TRIM_DB}dB,` +
      `areverse,` +
      `silenceremove=start_periods=1:start_silence=${TAIL_PAD}:start_threshold=${TRIM_DB}dB,` +
      `areverse`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", srcPath, "-af", filter, "-c:a", "aac", "-b:a", "192k", out],
      { stdio: ["ignore", "ignore", "inherit"] });
    const d = probeDur(out);
    if (d && d > 0.2) return out;   // 정상이면 트리밍본 사용
    return srcPath;                  // 너무 짧아지면(전부 묵음 등) 원본
  } catch { return srcPath; }
}

// 영상에 들어갈 컷: 이미지가 있고 + 나레이션(음성)이 있는 컷만
// (B0 같은 기준 이미지는 나레이션이 없으므로 자동 제외됨)
const segs = tl.segments.filter(s => {
  if (!s.image) return false;
  const ok = s.audio && fs.existsSync(path.join(exportDir, "audio", s.audio));
  return ok;
});
if (!segs.length) { console.error("✗ 렌더할 컷이 없습니다. (이미지+음성이 모두 있는 컷이 필요)"); process.exit(1); }
const skipped = tl.segments.filter(s => s.image && !(s.audio && fs.existsSync(path.join(exportDir, "audio", s.audio))));
if (skipped.length) console.log(`  (음성 없는 컷 ${skipped.length}개 제외: ${skipped.map(s=>s.id).join(", ")})\n`);

console.log(`▶ ${project} · 컷 ${segs.length}개 렌더 시작 (${W}x${H}, ${FPS}fps)\n`);

// 컷의 오버레이 설정 결정: segment.overlay 우선, 없으면 design 프리셋
function resolveOverlay(seg) {
  // 슬레이트에서 오버레이 전체 OFF로 내보낸 경우: 그레인·비네팅까지 모두 끔
  if (seg.overlay === "off") return { files: [], grain: 0, vignette: 0 };
  const preset = PRESET_OVERLAY[seg.design] || DEFAULT_OVERLAY;
  let files = preset.files ? [...preset.files] : [];
  // 대본 컷이 직접 지정한 overlay (예: "dust+lightleak", "none")
  if (seg.overlay) {
    if (seg.overlay === "none") files = [];
    else files = seg.overlay.split("+").map(s => s.trim()).filter(Boolean);
  }
  // 실제 파일이 있는 것만
  files = files.filter(t => fs.existsSync(path.join(exportDir, OVERLAY_DIR, t + ".mp4")));
  return { files, grain: preset.grain ?? DEFAULT_OVERLAY.grain, vignette: preset.vignette ?? DEFAULT_OVERLAY.vignette };
}

const partFiles = [];
segs.forEach((s, i) => {
  const imgPath = path.join(exportDir, "images", s.image);
  if (!fs.existsSync(imgPath)) { console.error(`  ✗ 이미지 없음, 건너뜀: ${s.image}`); return; }

  const audPathRaw = s.audio ? path.join(exportDir, "audio", s.audio) : null;
  const hasAudio = audPathRaw && fs.existsSync(audPathRaw);
  // 음성 앞뒤 묵음 제거 → 컷마다 빈 시간이 사라져 줌인이 안 끊김
  const audPath = hasAudio ? trimSilence(audPathRaw, i) : null;
  const audDur = hasAudio ? probeDur(audPath) : null;   // 트리밍된 음성의 실제 길이
  let dur;
  if (hasAudio && audDur) {
    // ★ 화면 길이 = 음성 길이 (100% 일치, 최소값 강제 없음) → 음성·화면 절대 안 밀림
    dur = +audDur.toFixed(3);
  } else {
    dur = +((s.duration || 3)).toFixed(3);
    dur = Math.max(1.2, dur);   // 음성 없는 컷만 기본 길이
  }

  const part = path.join(tmp, `part_${String(i).padStart(3, "0")}.mp4`);
  partFiles.push(part);

  const frames = Math.round(dur * FPS);
  const zInc = (ZOOM_MAX - 1.0);
  const ov = resolveOverlay(s);

  // --- 입력 구성 ---
  const inputs = ["-loop", "1", "-i", imgPath];      // [0] 이미지
  if (hasAudio) inputs.push("-i", audPath);          // [1] 음성
  const audioIdx = hasAudio ? 1 : -1;
  let nextIdx = hasAudio ? 2 : 1;
  const ovInputs = [];
  ov.files.forEach(tag => {
    inputs.push("-stream_loop", "-1", "-i", path.join(exportDir, OVERLAY_DIR, tag + ".mp4"));
    ovInputs.push(nextIdx++);
  });

  // --- 베이스: 켄번즈 + 그레인 + 비네팅 + 페이드 ---
  const fc = [];
  let chain =
    `[0:v]scale=${W*4}:${H*4}:force_original_aspect_ratio=increase,crop=${W*4}:${H*4},` +
    `zoompan=z='min(1.0+${zInc}*on/${frames},${ZOOM_MAX})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},` +
    `setsar=1`;
  if (ov.vignette > 0) chain += `,vignette=PI/4*${(ov.vignette*1.6).toFixed(2)}`;
  if (ov.grain > 0)    chain += `,noise=alls=${Math.round(ov.grain*200)}:allf=t`;
  fc.push(`${chain}[base]`);

  // --- 파일 오버레이를 screen 블렌드로 차례차례 합성 ---
  let last = "base";
  ovInputs.forEach((inIdx, k) => {
    const ovl = `ov${k}`, out = `m${k}`;
    fc.push(`[${inIdx}:v]scale=${W}:${H},setsar=1,format=gbrp,colorchannelmixer=aa=${OVERLAY_OPACITY}[${ovl}]`);
    fc.push(`[${last}][${ovl}]blend=all_mode=screen:shortest=1[${out}]`);
    last = out;
  });

  // --- 페이드 인/아웃 마무리 (짧은 컷은 페이드도 짧게) ---
  const fd = Math.min(FADE, dur / 3);
  fc.push(`[${last}]fade=t=in:st=0:d=${fd.toFixed(2)},fade=t=out:st=${(dur-fd).toFixed(2)}:d=${fd.toFixed(2)},format=yuv420p[vout]`);

  const args = ["-y", "-loglevel", "error", ...inputs,
    "-filter_complex", fc.join(";"), "-map", "[vout]"];
  if (hasAudio) args.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-t", String(dur), "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", part);

  const ovLabel = ov.files.length ? ` +${ov.files.join(",")}` : "";
  process.stdout.write(`\r  [${i + 1}/${segs.length}] ${s.id}  ${dur}s${ovLabel}   `);
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
});

console.log(`\n\n▶ 컷 이어붙이는 중...`);
const listPath = path.join(tmp, "concat.txt");
fs.writeFileSync(listPath, partFiles.map(f => `file '${path.resolve(f)}'`).join("\n"));

// 오디오 유무가 섞여 있을 수 있으므로 재인코딩으로 안전하게 concat
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-r", String(FPS), outFile],
  { stdio: ["ignore", "ignore", "inherit"] });

fs.rmSync(tmp, { recursive: true, force: true });

const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
console.log(`\n✅ 완성!\n   ${outFile}  (${mb} MB)\n`);
