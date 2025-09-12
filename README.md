# Mock Ingest API 테스트 가이드

단일 프레임 전송 / 타입 없음 / HMAC 인증 / SN 1회 바인딩

- **엔드포인트:** `POST /v1/ingest`
- **인증 헤더**
  - `X-Device-ID`: 발급된 장치 ID
  - `X-Timestamp`: epoch 밀리초(13자리 정수)
  - `X-Device-Sign`: `base64(HMAC_SHA256(secret, "<timestamp>.<sha256(body)>"))`
    - `sha256(body)`는 **압축 JSON 문자열** 기준의 해시(hex)

> 서버는 `JSON.stringify(req.body)`로 직렬화한 **압축 JSON**을 해시 기준으로 사용합니다.  
> 따라서 클라이언트도 **압축 JSON**을 해시와 전송에 **동일하게** 사용해야 서명이 일치합니다.

---

## 0) 준비물

- cURL
- 해시/HMAC 도구
  - **Linux/macOS:** `openssl`, `jq`
  - **Windows PowerShell:** .NET 내장 암호화 API
- 샘플 장치(예시)
  - **유량센서**: `deviceId=dev-flow-001`, `secret=FLw_7nQm2Zt9bH6cJ4Vr`

> 서버가 실행 중이어야 합니다: `http://localhost:3000`  
> 상태 확인: `GET /healthz`  
> 모델/허용키 확인: `GET /manifest/<deviceId>`

---

## 1) Linux / macOS

### 공통 변수

```bash
ENDPOINT="http://localhost:3000/api/v1/ingest"
DEVICE_ID="dev-flow-001"
SECRET="FLw_7nQm2Zt9bH6cJ4Vr"

# epoch ms (macOS 포함 안전)
TS=$(($(date +%s)*1000))
```

### 요청 바디 (압축 JSON으로 통일)

```bash
BODY='{
  "schemaVersion": 1,
  "hardwareSN": "MB-SN-FLOW-001",
  "observedAt": "2025-09-11T05:10:00.000Z",
  "data": { "flow.rate.lpm": 32.4 }
}'

BODY_C=$(printf '%s' "$BODY" | jq -c .)
```

### 서명 생성

```bash
BODY_HASH=$(printf '%s' "$BODY_C" | openssl dgst -sha256 -hex | sed 's/^.* //')
SIGN_INPUT="${TS}.${BODY_HASH}"
SIGN=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
```

### 전송

```bash
curl -sS "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-Device-ID: $DEVICE_ID" \
  -H "X-Timestamp: $TS" \
  -H "X-Device-Sign: $SIGN" \
  -d "$BODY_C"
```

> macOS에서는 `date +%s%3N`이 동작하지 않습니다.  
> 반드시 `TS=$(($(date +%s)*1000))` 방식 사용하세요.

---

## 2) Windows PowerShell

### 공통 변수

```powershell
$Endpoint = "http://localhost:3000/api/v1/ingest"
$DeviceId = "dev-flow-001"
$Secret   = "FLw_7nQm2Zt9bH6cJ4Vr"

# epoch ms
$TS = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
```

### 요청 바디 → 압축 JSON

```powershell
$BodyObj = @{
  schemaVersion = 1
  hardwareSN    = "MB-SN-FLOW-001"
  observedAt    = "2025-09-11T05:10:00.000Z"
  data          = @{ "flow.rate.lpm" = 32.4 }
}

$BodyC = ($BodyObj | ConvertTo-Json -Compress)
```

### 해시 및 서명 생성

```powershell
# SHA256(body)
$sha256   = [System.Security.Cryptography.SHA256]::Create()
$bytes    = [System.Text.Encoding]::UTF8.GetBytes($BodyC)
$hash     = $sha256.ComputeHash($bytes)
$bodyHash = ($hash | ForEach-Object ToString x2) -join ""

# signInput = "<timestamp>.<bodyHash>"
$signInput = "$TS.$bodyHash"

# HMAC-SHA256(base64)
$hmac     = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($Secret))
$signRaw  = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($signInput))
$sign     = [Convert]::ToBase64String($signRaw)
```

### 전송

```powershell
$Headers = @{
  "Content-Type"  = "application/json"
  "X-Device-ID"   = $DeviceId
  "X-Timestamp"   = $TS
  "X-Device-Sign" = $sign
}

Invoke-RestMethod -Uri $Endpoint -Method Post -Headers $Headers -Body $BodyC
```

---

## 3) 모델별 샘플 (Linux/macOS 기준)

### 랙 냉매센서

```bash
DEVICE_ID="dev-rack-coolant-001"
SECRET="RKx_2Pq5M4F9gE3yP1Jv"
TS=$(($(date +%s)*1000))
BODY_C='{"schemaVersion":1,"hardwareSN":"MB-SN-COOLANT-001","observedAt":"2025-09-11T05:10:00.000Z","data":{"water.temp1.c":24.7,"water.temp2.c":25.0,"water.temp3.c":25.3,"room.temp.c":22.4,"room.humi.pct":41.9,"tank.level.ok":true}}'
BODY_HASH=$(printf '%s' "$BODY_C" | openssl dgst -sha256 -hex | sed 's/^.* //'); SIGN_INPUT="${TS}.${BODY_HASH}"
SIGN=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -sS http://localhost:3000/api/v1/ingest -H "Content-Type: application/json" -H "X-Device-ID: $DEVICE_ID" -H "X-Timestamp: $TS" -H "X-Device-Sign: $SIGN" -d "$BODY_C"
```

### 유량센서

```bash
DEVICE_ID="dev-flow-001"
SECRET="FLw_7nQm2Zt9bH6cJ4Vr"
TS=$(($(date +%s)*1000))
BODY_C='{"schemaVersion":1,"hardwareSN":"MB-SN-FLOW-001","observedAt":"2025-09-11T05:10:00.000Z","data":{"flow.rate.lpm":32.4}}'
BODY_HASH=$(printf '%s' "$BODY_C" | openssl dgst -sha256 -hex | sed 's/^.* //'); SIGN_INPUT="${TS}.${BODY_HASH}"
SIGN=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -sS http://localhost:3000/api/v1/ingest -H "Content-Type: application/json" -H "X-Device-ID: $DEVICE_ID" -H "X-Timestamp: $TS" -H "X-Device-Sign: $SIGN" -d "$BODY_C"
```

### 전압센서 보드 (예: dev-voltage-002)

```bash
DEVICE_ID="dev-voltage-002"
SECRET="VOLT_2_dEf456"
TS=$(($(date +%s)*1000))
BODY_C='{"schemaVersion":1,"hardwareSN":"MB-SN-VOLT-002","observedAt":"2025-09-11T05:10:00.000Z","data":{"psu.v1.v":11.98,"psu.v2.v":12.01}}'
BODY_HASH=$(printf '%s' "$BODY_C" | openssl dgst -sha256 -hex | sed 's/^.* //'); SIGN_INPUT="${TS}.${BODY_HASH}"
SIGN=$(printf '%s' "$SIGN_INPUT" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -sS http://localhost:3000/api/v1/ingest -H "Content-Type: application/json" -H "X-Device-ID: $DEVICE_ID" -H "X-Timestamp: $TS" -H "X-Device-Sign: $SIGN" -d "$BODY_C"
```

---

## 4) 에러 해결 가이드

- **invalid X-Timestamp**

  - 13자리 정수(epoch ms)여야 합니다.
  - macOS: `TS=$(($(date +%s)*1000))` 사용

- **bad signature**

  - 압축 JSON(`jq -c .` / `ConvertTo-Json -Compress`)을 해시와 전송에 모두 사용했는지 확인

- **key not allowed for this device model**

  - `/manifest/<deviceId>`로 허용 키 확인

- **missing required key**

  - 모델 정의에서 필수 키 누락

- **hardwareSN mismatch**
  - 장치 최초 전송 SN과 다름 → 서버에서 초기화 필요
