#!/usr/bin/env node
/* ============================================================
   무음 제거 스크립트  (프롬프트 슬레이트)
   영상에서 소리가 없는 구간을 자동으로 잘라내고
   소리 있는 부분만 이어붙여 새 영상을 만듭니다.

   사용법:
     node remove_silence.js <영상파일> [출력파일]
   예시:
     node remove_silence.js 전두환편.mp4
     node remove_silence.js 전두환편.mp4 전두환편_컷.mp4

   필요: ffmpeg, ffprobe (brew install ffmpeg)
   ============================================================ */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ---------- 설정 (필요하면 이 숫자만 바꾸세요) ----------
const NOISE_DB      = -30;    // 이 dB보다 조용하면 '무음'으로 간주 (-30 권장, 더 민감하게: -35)
const MIN_SILENCE   = 0.45;   // 이 길이(초) 이상 무음만 잘라냄 (너무 짧은 건 자연스러운 숨)
const KEEP_PAD      = 0.10;   // 잘라낸 구간 앞뒤로 이만큼(초) 소리를 남겨 끊김 방지
const MIN_SEGMENT   = 0.15;   // 이보다 짧은 소리 조각은 버림(노이즈 방지)
// ------------------------------------------------------

const input = process.argv[2];
if (!input) {
  console.log("사용법: node remove_silence.js <영상파일> [출력파일]");
  process.exit(1);
}
if (!fs.existsSync(input)) {
  console.error("✗ 파일을 찾을 수 없습니다: " + input);
  process.exit(1);
}

const ext = path.extname(input);
const base = path.basename(input, ext);
const output = process.argv[3] || path.join(path.dirname(input), base + "_무음제거" + ext);

// ffmpeg 존재 확인
function has(cmd){ try{ execSync(cmd+" -version",{stdio:"ignore"}); return true; }catch(e){ return false; } }
if (!has("ffmpeg") || !has("ffprobe")) {
  console.error("✗ ffmpeg가 없습니다. 터미널에 'brew install ffmpeg' 를 먼저 실행하세요.");
  process.exit(1);
}

// 전체 길이
function probeDuration(file){
  const r = spawnSync("ffprobe", ["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1", file], {encoding:"utf8"});
  return parseFloat((r.stdout||"").trim()) || 0;
}
const total = probeDuration(input);
if (!total) { console.error("✗ 영상 길이를 읽지 못했습니다."); process.exit(1); }

console.log(`\n🎬 입력: ${path.basename(input)}  (${total.toFixed(1)}초)`);
console.log(`   기준: ${NOISE_DB}dB 이하가 ${MIN_SILENCE}초 이상이면 무음으로 잘라냄\n`);
console.log("🔎 무음 구간 분석 중...");

// silencedetect 실행 → stderr에 결과가 나옴
const det = spawnSync("ffmpeg", [
  "-i", input,
  "-af", `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE}`,
  "-f", "null", "-"
], {encoding:"utf8"});

const log = det.stderr || "";
// silence_start / silence_end 파싱
const silences = [];
let curStart = null;
log.split("\n").forEach(line=>{
  const ms = line.match(/silence_start:\s*([0-9.]+)/);
  const me = line.match(/silence_end:\s*([0-9.]+)/);
  if (ms) curStart = parseFloat(ms[1]);
  if (me && curStart !== null) { silences.push([curStart, parseFloat(me[1])]); curStart = null; }
});

if (!silences.length) {
  console.log("✓ 잘라낼 무음 구간이 없습니다. 영상이 그대로 복사됩니다.");
  fs.copyFileSync(input, output);
  console.log("📁 저장: " + output);
  process.exit(0);
}

// 무음 구간을 빼고 '소리 있는 구간(keep)'을 계산
const keep = [];
let cursor = 0;
for (const [s, e] of silences) {
  const segStart = cursor;
  const segEnd = s + KEEP_PAD;            // 무음 시작 직전까지(패딩 포함)
  if (segEnd - segStart >= MIN_SEGMENT) keep.push([Math.max(0,segStart), Math.min(total,segEnd)]);
  cursor = e - KEEP_PAD;                  // 무음 끝 직후부터 다시 시작
  if (cursor < 0) cursor = 0;
}
if (total - cursor >= MIN_SEGMENT) keep.push([Math.max(0,cursor), total]);

// 겹치거나 역전된 구간 정리
const segs = [];
for (const [s,e] of keep){ if(e>s){ if(segs.length && s<=segs[segs.length-1][1]){ segs[segs.length-1][1]=Math.max(segs[segs.length-1][1],e);} else segs.push([s,e]); } }

const culSilence = total - segs.reduce((a,[s,e])=>a+(e-s),0);
console.log(`   무음 ${silences.length}곳 발견 · 약 ${culSilence.toFixed(1)}초 제거 예정 (${segs.length}개 구간 유지)\n`);

// 각 구간을 잘라 임시 파일로, 그다음 concat
const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "desil_"));
const parts = [];
console.log("✂️  구간 잘라내는 중...");
segs.forEach(([s,e],i)=>{
  const part = path.join(tmp, `p${String(i).padStart(4,"0")}.ts`);
  // 정확한 컷을 위해 재인코딩 (mpegts로 뽑아 concat 안전하게)
  const r = spawnSync("ffmpeg", [
    "-y","-ss", s.toFixed(3), "-to", e.toFixed(3), "-i", input,
    "-c:v","libx264","-preset","veryfast","-crf","18",
    "-c:a","aac","-b:a","192k",
    "-avoid_negative_ts","make_zero","-f","mpegts", part
  ], {encoding:"utf8"});
  if (fs.existsSync(part)) { parts.push(part); process.stdout.write(`\r   ${i+1}/${segs.length}`); }
});
console.log("");

if (!parts.length) { console.error("✗ 잘라낸 구간이 없습니다."); process.exit(1); }

// concat
console.log("\n🔗 이어붙이는 중...");
const listFile = path.join(tmp, "list.txt");
fs.writeFileSync(listFile, parts.map(p=>`file '${p}'`).join("\n"));
const cat = spawnSync("ffmpeg", [
  "-y","-f","concat","-safe","0","-i", listFile,
  "-c:v","libx264","-preset","veryfast","-crf","18","-c:a","aac","-b:a","192k",
  output
], {encoding:"utf8"});

// 정리
try { parts.forEach(p=>fs.unlinkSync(p)); fs.unlinkSync(listFile); fs.rmdirSync(tmp); } catch(e){}

if (!fs.existsSync(output)) {
  console.error("✗ 출력 생성 실패\n" + (cat.stderr||"").split("\n").slice(-8).join("\n"));
  process.exit(1);
}
const newDur = probeDuration(output);
console.log(`\n✅ 완료!`);
console.log(`   ${total.toFixed(1)}초 → ${newDur.toFixed(1)}초  (${(total-newDur).toFixed(1)}초 단축)`);
console.log(`📁 저장: ${output}\n`);
