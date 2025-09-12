// 사용법: node client-sample.js http://localhost:3000 dev-rack-coolant-001 RKx_2Pq5M4F9gE3yP1Jv
const [, , BASE, DEVICE_ID, SECRET] = process.argv;
const crypto = require("crypto");
const http = require("http");

function sign(ts, raw) {
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return crypto
    .createHmac("sha256", SECRET)
    .update(`${ts}.${hash}`)
    .digest("base64");
}

// === 여기서 보낼 바디를 정의 (보드별로 교체) ===
const body = {
  schemaVersion: 1,
  hardwareSN: "MB-SN-COOLANT-001",
  observedAt: new Date().toISOString(),
  data: {
    "water.temp1.c": 24.7,
    "water.temp2.c": 24.8,
    "water.temp3.c": 25.1,
    "room.temp.c": 23.9,
    "room.humi.pct": 42.0,
    "tank.level.ok": true,
  },
};

const raw = JSON.stringify(body);
const ts = Date.now().toString();
const sig = sign(ts, raw);

const req = http.request(
  new URL("/v1/ingest", BASE),
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-ID": DEVICE_ID,
      "X-Timestamp": ts,
      "X-Device-Sign": sig,
    },
  },
  (res) => {
    let chunks = "";
    res.on("data", (d) => (chunks += d));
    res.on("end", () => {
      console.log("STATUS", res.statusCode);
      console.log(chunks);
    });
  }
);
req.on("error", console.error);
req.write(raw);
req.end();
