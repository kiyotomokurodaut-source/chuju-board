#!/usr/bin/env node
/**
 * 定期スクレイパー: 各校の最新情報(入試日程・説明会・優遇制度・塾別実績)を
 * Anthropic API + Web検索で構造化取得し、data/ 配下にJSONで保存する。
 *
 * 環境変数:
 *   ANTHROPIC_API_KEY  必須(MOCK=1 のときは不要)
 *   BATCH_SIZE         1回の実行で処理する学校数(既定 25)。前回の続きから巡回する
 *   FULL=1             全校を一括処理
 *   MOCK=1             APIを呼ばずダミーデータでパイプラインを検証
 *   MOCK_VARIANT=2     MOCK時に差分を発生させる(changelog動作確認用)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const SCHOOL_DIR = path.join(DATA, "schools");
const MOCK = process.env.MOCK === "1";
const FULL = process.env.FULL === "1";
const BATCH = Math.max(1, Number(process.env.BATCH_SIZE || 25));
const KEY = process.env.ANTHROPIC_API_KEY;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; }
};

function buildPrompt(s) {
  return `「${s.name}」(${s.pref}の中学校)について、web検索で学校公式サイトと各塾の公式サイトを中心に調べ、次のJSONだけを返してください。前置き・説明・コードフェンスは一切禁止。確認できない項目は空配列に。各要素には必ず実在の出典URL(source)を含め、出典が確認できない情報は含めないこと。
{"exams":[{"date":"YYYY-MM-DD","slot":"AM|PM","name":"回の名称","note":"科目・方式など","source":"URL"}],"sessions":[{"date":"YYYY-MM-DD","name":"説明会・行事名","note":"予約方法など","source":"URL"}],"preferences":[{"desc":"優遇・特待・加点・複数回優遇などの制度","source":"URL"}],"juku":[{"name":"塾名","count":合格者数の数値,"year":"2026","source":"URL"}],"dev":{"scale":"四谷大塚80偏差値など模試名","value":数値,"source":"URL"},"notes":"補足や不明点"}
対象: 2027年度入試(2027年1〜2月実施)の日程・方式、2026年開催予定の学校説明会・入試説明会、塾別合格者数は2026年入試の公表値(SAPIX・日能研・四谷大塚・早稲田アカデミーなど)。各配列は重要なものから最大6件。簡潔に。`;
}

async function callApi(school) {
  if (MOCK) {
    const base = {
      exams: [{ date: "2027-02-01", slot: "AM", name: "第1回(モック)", note: "", source: "https://example.com/exam" }],
      sessions: [{ date: "2026-10-10", name: "学校説明会(モック)", note: "ミライコンパス予約", source: "https://example.com/event" }],
      preferences: [], juku: [{ name: "SAPIX", count: 12, year: "2026", source: "https://example.com/juku" }],
      notes: "MOCKデータ"
    };
    if (process.env.MOCK_VARIANT === "2") {
      base.sessions.push({ date: "2026-11-21", name: "入試説明会(モック追加)", note: "", source: "https://example.com/event2" });
    }
    return base;
  }
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [{ role: "user", content: buildPrompt(school) }],
    tools: [{ type: "web_search_20250305", name: "web_search" }]
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "API error");
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no JSON in response");
      return JSON.parse(m[0]);
    } catch (e) {
      lastErr = e;
      await sleep(3000 * attempt);
    }
  }
  throw lastErr;
}

/* ---- 差分検出 ---- */
const FIELD_LABEL = { exams: "入試日程", sessions: "説明会・行事", preferences: "優遇・特待", juku: "塾別実績" };
function keyOf(field, x) {
  if (field === "preferences") return x.desc || "";
  if (field === "juku") return `${x.name || ""}|${x.count ?? ""}|${x.year || ""}`;
  return `${x.date || ""}|${x.name || ""}`;
}
function diffSchool(oldD, newD) {
  const msgs = [];
  for (const f of Object.keys(FIELD_LABEL)) {
    const oldKeys = new Set(((oldD && oldD[f]) || []).map(x => keyOf(f, x)));
    for (const x of (newD[f] || [])) {
      if (!oldKeys.has(keyOf(f, x))) {
        const head = x.date ? `${x.date} ` : "";
        const bodyTxt = x.name || x.desc || (x.count != null ? `${x.name || ""} ${x.count}名` : "");
        msgs.push(`${FIELD_LABEL[f]}: ${head}${bodyTxt} を新規検出`);
      }
    }
  }
  return msgs;
}

/* ---- メイン ---- */
async function main() {
  if (!MOCK && !KEY) {
    console.error("ANTHROPIC_API_KEY が未設定です(検証だけなら MOCK=1 を付けてください)");
    process.exit(1);
  }
  await mkdir(SCHOOL_DIR, { recursive: true });
  const schools = JSON.parse(await readFile(path.join(ROOT, "scraper", "schools.json"), "utf8"));
  const state = await readJson(path.join(DATA, "state.json"), { cursor: 0 });
  const summary = await readJson(path.join(DATA, "summary.json"), { generatedAt: null, schools: {} });
  const changelog = await readJson(path.join(DATA, "changelog.json"), []);

  let targets;
  if (FULL) {
    targets = schools;
  } else {
    const start = state.cursor % schools.length;
    targets = Array.from({ length: Math.min(BATCH, schools.length) }, (_, i) => schools[(start + i) % schools.length]);
    state.cursor = (start + targets.length) % schools.length;
  }
  console.log(`処理対象: ${targets.map(s => s.name).join(", ")}`);

  let ok = 0, ng = 0;
  for (const s of targets) {
    const prevPath = path.join(SCHOOL_DIR, `${s.id}.json`);
    const prev = await readJson(prevPath, null);
    try {
      const fetched = await callApi(s);
      const record = {
        id: s.id, name: s.name,
        fetchedAt: new Date().toISOString(),
        exams: fetched.exams || [], sessions: fetched.sessions || [],
        preferences: fetched.preferences || [], juku: fetched.juku || [],
        dev: (fetched.dev && typeof fetched.dev.value === "number") ? fetched.dev : null,
        notes: fetched.notes || ""
      };
      const changes = diffSchool(prev, record);
      if (changes.length) {
        changelog.unshift({ ts: record.fetchedAt, schoolId: s.id, schoolName: s.name, changes });
      }
      await writeFile(prevPath, JSON.stringify(record, null, 1));
      summary.schools[s.id] = record;
      ok++;
      console.log(`✓ ${s.name}(変更 ${changes.length}件)`);
    } catch (e) {
      ng++;
      console.error(`✗ ${s.name}: ${e.message}(前回データを保持)`);
    }
    if (!MOCK) await sleep(1500);
  }

  summary.generatedAt = new Date().toISOString();
  changelog.length = Math.min(changelog.length, 300);
  await writeFile(path.join(DATA, "summary.json"), JSON.stringify(summary, null, 1));
  await writeFile(path.join(DATA, "changelog.json"), JSON.stringify(changelog, null, 1));
  await writeFile(path.join(DATA, "state.json"), JSON.stringify(state, null, 1));
  console.log(`完了: 成功 ${ok} / 失敗 ${ng} / 次回カーソル ${state.cursor}`);
  if (ok === 0 && targets.length > 0) process.exit(1);
}
main();
