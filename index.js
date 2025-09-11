// 단일 프레임 전송 / meta 없음 / 타입은 서버의 모델 정의로 검증
// 인증: X-Device-ID + X-Timestamp + X-Device-Sign (HMAC-SHA256 base64)
// SN(하드웨어 S/N) 1회 바인딩

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// ────────────────────────────────────────────────
// 0) 설정값
// ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const MAX_BODY_BYTES = "256kb";
const ALLOWED_SKEW_MS = 120_000; // ±120초 허용
const SCHEMA_VERSION = 1;

// ────────────────────────────────────────────────
/**
 * 1) 디바이스 "모델" 정의 (화이트리스트)
 *   - key: 문자열
 *   - type: 'number' | 'boolean'
 *   - required: true 면 매 프레임에 반드시 존재해야 함
 *   - nullable: 허용 시 true (기본 false)
 */
// ────────────────────────────────────────────────
const DEVICE_MODELS = {
  // 1) 랙 냉매센서 보드 (온도센서 3개 + 온습도센서 1세트 + 수위센서 1개)
  RACK_COOLANT_V1: {
    name: "rack-coolant-board",
    version: "v1",
    keys: [
      // 온도센서 *3 (float)
      { key: "water.temp1.c", type: "number", required: true },
      { key: "water.temp2.c", type: "number", required: true },
      { key: "water.temp3.c", type: "number", required: true },
      // 온습도센서 *1 (온도°C + 습도%)
      { key: "room.temp.c", type: "number", required: true },
      { key: "room.humi.pct", type: "number", required: true },
      // 수위센서 *1 (boolean)
      { key: "tank.level.ok", type: "boolean", required: true },
    ],
  },

  // 2) 유량센서 보드 (유량센서 1개)
  FLOW_V1: {
    name: "flow-board",
    version: "v1",
    keys: [
      { key: "flow.rate.lpm", type: "number", required: true }, // LPM 가정
    ],
  },

  // 3) 전압센서 보드 (전압센서 2개)
  VOLTAGE_BOARD_V1: {
    name: "voltage-board",
    version: "v1",
    keys: [
      { key: "psu.v1.v", type: "number", required: true },
      { key: "psu.v2.v", type: "number", required: true },
    ],
  },
};

// ────────────────────────────────────────────────
/**
 * 2) 실제 디바이스(보드) 발급 정보 (메모리 저장)
 *   - deviceId: 보드 식별자
 *   - secret: 보드 전용 서명 키
 *   - model: 위 모델 키
 *   - boundHardwareSN: 최초 수신한 SN을 바인딩(다르면 거절)
 */
// ────────────────────────────────────────────────
const DEVICES = [
  // 랙 냉매센서 1대
  {
    deviceId: "dev-rack-coolant-001",
    secret: "RKx_2Pq5M4F9gE3yP1Jv", // 예시 키 (벤더에 전달)
    model: "RACK_COOLANT_V1",
    enabled: true,
    boundHardwareSN: null,
  },
  // 유량센서 1대
  {
    deviceId: "dev-flow-001",
    secret: "FLw_7nQm2Zt9bH6cJ4Vr",
    model: "FLOW_V1",
    enabled: true,
    boundHardwareSN: null,
  },
  // 전압센서 보드 4대 (동일 모델, 서로 다른 deviceId/secret)
  {
    deviceId: "dev-voltage-001",
    secret: "VOLT_1_aBc123",
    model: "VOLTAGE_BOARD_V1",
    enabled: true,
    boundHardwareSN: null,
  },
  {
    deviceId: "dev-voltage-002",
    secret: "VOLT_2_dEf456",
    model: "VOLTAGE_BOARD_V1",
    enabled: true,
    boundHardwareSN: null,
  },
  {
    deviceId: "dev-voltage-003",
    secret: "VOLT_3_gHi789",
    model: "VOLTAGE_BOARD_V1",
    enabled: true,
    boundHardwareSN: null,
  },
  {
    deviceId: "dev-voltage-004",
    secret: "VOLT_4_jKl012",
    model: "VOLTAGE_BOARD_V1",
    enabled: true,
    boundHardwareSN: null,
  },
];

// 빠른 조회용 맵
const DEVICE_MAP = new Map(DEVICES.map((d) => [d.deviceId, d]));

// ────────────────────────────────────────────────
// 3) 유틸
// ────────────────────────────────────────────────
function hmacBase64(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function nowMs() {
  return Date.now();
}

// ────────────────────────────────────────────────
// 4) 서버
// ────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json({ limit: MAX_BODY_BYTES }));

// 상태 확인
app.get("/healthz", (_, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// (선택) 장치 허용 키 목록 조회 — 벤더 개발 편의용
app.get("/manifest/:deviceId", (req, res) => {
  const d = DEVICE_MAP.get(req.params.deviceId);
  if (!d) return res.status(404).json({ ok: false, error: "unknown deviceId" });
  const model = DEVICE_MODELS[d.model];
  return res.json({
    ok: true,
    deviceId: d.deviceId,
    model: model.name,
    version: model.version,
    keys: model.keys,
    schemaVersion: SCHEMA_VERSION,
  });
});

/**
 * 단일 프레임 수신 엔드포인트
 * POST /v1/ingest
 * 헤더:
 *  - X-Device-ID
 *  - X-Timestamp (epoch ms)
 *  - X-Device-Sign (base64(HMAC-SHA256(body + timestamp, secret)))
 * 바디:
 *  {
 *    "schemaVersion": 1,
 *    "hardwareSN": "MB-SN-XXXX",
 *    "observedAt": "2025-09-11T05:10:00.000Z",
 *    "data": { "water.temp1.c": 24.7, ... }
 *  }
 */
app.post("/v1/ingest", (req, res) => {
  try {
    // ── 1) 인증 헤더
    const deviceId = req.header("X-Device-ID");
    const tsHeader = req.header("X-Timestamp");
    const signHeader = req.header("X-Device-Sign");

    if (!deviceId || !tsHeader || !signHeader) {
      return res.status(401).json({ ok: false, error: "missing auth headers" });
    }
    const device = DEVICE_MAP.get(deviceId);
    if (!device || !device.enabled) {
      return res
        .status(403)
        .json({ ok: false, error: "unknown or disabled device" });
    }

    const clientTs = Number(tsHeader);
    if (!Number.isFinite(clientTs)) {
      return res.status(400).json({ ok: false, error: "invalid X-Timestamp" });
    }
    const skew = Math.abs(nowMs() - clientTs);
    if (skew > ALLOWED_SKEW_MS) {
      return res
        .status(400)
        .json({ ok: false, error: "timestamp skew too large" });
    }

    // ── 2) 본문 파싱/서명 검증
    const rawBody = JSON.stringify(req.body ?? {});
    const expectedSign = hmacBase64(device.secret, rawBody + tsHeader);
    if (
      !crypto.timingSafeEqual(
        Buffer.from(expectedSign),
        Buffer.from(signHeader)
      )
    ) {
      return res.status(401).json({ ok: false, error: "bad signature" });
    }

    // ── 3) 스키마 기본 항목
    const { schemaVersion, hardwareSN, observedAt, data } = req.body || {};
    if (schemaVersion !== SCHEMA_VERSION) {
      return res
        .status(400)
        .json({ ok: false, error: "schemaVersion mismatch" });
    }
    if (!hardwareSN || typeof hardwareSN !== "string") {
      return res.status(400).json({ ok: false, error: "hardwareSN required" });
    }
    if (
      !observedAt ||
      typeof observedAt !== "string" ||
      isNaN(Date.parse(observedAt))
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "observedAt must be ISO string" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({ ok: false, error: "data object required" });
    }

    // ── 4) SN 바인딩(최초 1회 고정)
    if (!device.boundHardwareSN) {
      device.boundHardwareSN = hardwareSN;
      console.log(`[bind] ${device.deviceId} -> ${hardwareSN}`);
    } else if (device.boundHardwareSN !== hardwareSN) {
      return res.status(403).json({ ok: false, error: "hardwareSN mismatch" });
    }

    // ── 5) 모델 키·타입 화이트리스트 검증
    const model = DEVICE_MODELS[device.model];
    if (!model) {
      return res.status(500).json({ ok: false, error: "server model missing" });
    }
    const allowedMap = new Map(model.keys.map((k) => [k.key, k]));

    const errors = [];

    // a) 미허용 키 / 타입 검사
    for (const [k, v] of Object.entries(data)) {
      const rule = allowedMap.get(k);
      if (!rule) {
        errors.push({
          key: k,
          reason: "key not allowed for this device model",
        });
        continue;
      }
      if (rule.type === "number") {
        if (!isFiniteNumber(v)) {
          errors.push({
            key: k,
            reason: "type mismatch: expected number (finite)",
          });
        }
      } else if (rule.type === "boolean") {
        if (typeof v !== "boolean") {
          errors.push({ key: k, reason: "type mismatch: expected boolean" });
        }
      } else {
        errors.push({ key: k, reason: `unsupported type rule: ${rule.type}` });
      }
    }

    // b) 필수 키 누락 검사
    for (const rule of model.keys) {
      if (rule.required && !(rule.key in data)) {
        errors.push({ key: rule.key, reason: "missing required key" });
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        serverTime: new Date().toISOString(),
        errors,
      });
    }

    // ── 6) 저장 대신 콘솔 출력(모킹)
    console.log(
      `[ingest] device=${deviceId} model=${model.name}@${model.version}`
    );
    console.log(`  observedAt=${observedAt}  data=${JSON.stringify(data)}`);

    // 성공 응답
    return res.json({
      ok: true,
      serverTime: new Date().toISOString(),
      acceptedKeys: Object.keys(data).length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`Mock ingest server listening on http://localhost:${PORT}`);
  console.log(`\n== Test devices (ID / secret / model) ==`);
  DEVICES.forEach((d) => {
    console.log(
      `- ${d.deviceId}  |  secret: ${d.secret}  |  model: ${d.model}`
    );
  });
  console.log(`\nManifest example: GET /manifest/dev-rack-coolant-001`);
});
