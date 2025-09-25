// 사용법:
//   node javascript-sample.js http://localhost:3000 rack-coolant-board dev-rack-coolant-001 RKx_2Pq5M4F9gE3yP1Jv MB-SN-COOLANT-001
//   PERIOD_SECS=2 node javascript-sample.js http://localhost:3000 flow-board dev-flow-001 FLw_7nQm2Zt9bH6cJ4Vr MB-SN-FLOW-001
//   PERIOD_SECS=5 node javascript-sample.js http://localhost:3000 voltage-board dev-voltage-001 VOLT_1_aBc123 MB-SN-VOLT-001
const [, , BASE, BOARD_TYPE, DEVICE_ID, SECRET, HW_SN_CLI] = process.argv;

if (!BASE || !BOARD_TYPE || !DEVICE_ID || !SECRET || !HW_SN_CLI) {
  console.error(
    "Usage: node javascript-sample.js <BASE_URL> <BOARD_TYPE> <DEVICE_ID> <SECRET> <HW_SN_CLI>\n" +
      "BOARD_TYPE: rack-coolant-board | flow-board | voltage-board\n" +
      "Option: PERIOD_SECS=<n> for periodic sending"
  );
  process.exit(1);
}

const crypto = require("crypto");
const http = require("http");

// ─────────────────────────────────────────────────────────────
// 스키마(보드 종류별 필드정의): 이름으로 매칭하지 않고 '보드 종류'로만 매칭
// type: "number" | "boolean"
// scale: 소수점 자리수
// ─────────────────────────────────────────────────────────────
const SCHEMAS = {
  "rack-coolant-board": [
    { key: "water.temp1.c", type: "number", min: 18, max: 32, scale: 1 },
    { key: "water.temp2.c", type: "number", min: 18, max: 32, scale: 1 },
    { key: "water.temp3.c", type: "number", min: 18, max: 32, scale: 1 },
  ],
  "rack-room-board": [
    { key: "room.temp.c", type: "number", min: 18, max: 27, scale: 1 },
    { key: "room.humi.pct", type: "number", min: 20, max: 60, scale: 1 },
    // 탱크 레벨은 정상(true)이 더 자주 나오도록 90% true, 10% false
    { key: "tank.level.ok", type: "boolean", trueProb: 1 },
  ],
  "flow-board": [
    { key: "flow.rate.lpm", type: "number", min: 0, max: 100, scale: 1 },
  ],
  "voltage-board": [
    { key: "psu.v1.v", type: "number", min: 0, max: 24, scale: 2 },
    { key: "psu.v2.v", type: "number", min: 0, max: 24, scale: 2 },
  ],
};

if (!SCHEMAS[BOARD_TYPE]) {
  console.error(
    `Unknown BOARD_TYPE: ${BOARD_TYPE}\nValid: ${Object.keys(SCHEMAS).join(
      ", "
    )}`
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 랜덤 값 생성기
// ─────────────────────────────────────────────────────────────
function randFloat(min, max, scale) {
  const v = Math.random() * (max - min) + min;
  // 소수점 자리수(scale)에 맞춰 고정
  return parseFloat(v.toFixed(scale));
}

function randBoolean(trueProb = 0.5) {
  return Math.random() < trueProb;
}

function buildData(boardType) {
  const spec = SCHEMAS[boardType];
  const data = {};
  for (const field of spec) {
    if (field.type === "number") {
      data[field.key] = randFloat(field.min, field.max, field.scale ?? 0);
    } else if (field.type === "boolean") {
      data[field.key] = randBoolean(field.trueProb ?? 0.5);
    }
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// 서명 함수
// ─────────────────────────────────────────────────────────────
function sign(ts, raw) {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${ts}.${hash}`)
    .digest("base64");
}

// ─────────────────────────────────────────────────────────────
// 요청 전송
// ─────────────────────────────────────────────────────────────
function sendOnce() {
  const body = {
    schemaVersion: 1,
    hardwareSN: HW_SN_CLI, // 필요 시 환경변수나 규칙으로 치환 가능
    observedAt: new Date().toISOString(),
    data: buildData(BOARD_TYPE),
  };

  const raw = JSON.stringify(body);
  const ts = Date.now().toString();
  const sig = sign(ts, raw);

  const req = http.request(
    new URL("/api/v1/ingest", BASE),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-ID": DEVICE_ID,
        "X-Timestamp": ts,
        "X-Device-Sign": sig,
      },
      timeout: 10_000,
    },
    (res) => {
      let chunks = "";
      res.on("data", (d) => (chunks += d));
      res.on("end", () => {
        console.log(`[${new Date().toISOString()}] STATUS`, res.statusCode);
        if (chunks) console.log(chunks);
      });
    }
  );
  req.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] ERROR`, err?.message || err);
  });
  req.write(raw);
  req.end();
}

// ─────────────────────────────────────────────────────────────
// 실행: PERIOD_SECS가 있으면 주기적으로, 아니면 1회
// ─────────────────────────────────────────────────────────────
const periodSecs = Number(process.env.PERIOD_SECS || "");
if (Number.isFinite(periodSecs) && periodSecs > 0) {
  console.log(
    `Start periodic sending every ${periodSecs}s — BOARD_TYPE=${BOARD_TYPE}, DEVICE_ID=${DEVICE_ID}`
  );
  // 즉시 1회 전송 후 interval
  sendOnce();
  setInterval(sendOnce, periodSecs * 1000);
} else {
  sendOnce();
}
