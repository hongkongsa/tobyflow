# TobyFlow v2 — API Contract

Base URL: `https://labs.toby.vn/api/v1`

## Authentication

Mọi request đều signed bằng HMAC-SHA256:
```
X-Extension-Id: {chrome.runtime.id}
X-Timestamp: {unix_timestamp_ms}
X-Signature: HMAC-SHA256(enrollment_secret, message)

message = "{timestamp}:{METHOD}:{path}:{sha256(body)}"
```

JWT Token trong header:
```
Authorization: Bearer {jwt_token}
```

---

## 1. Auth Endpoints

### POST /auth/login
```json
Request: { "email": "string", "password": "string" }
Response: { "token": "jwt_string", "user": { "id", "email", "name", "plan" } }
```

### POST /auth/register
```json
Request: { "email": "string", "password": "string", "name": "string" }
Response: { "token": "jwt_string", "user": {...} }
```

### POST /auth/refresh
```json
Request: { "refresh_token": "string" }
Response: { "token": "new_jwt", "refresh_token": "new_refresh" }
```

---

## 2. Enrollment Endpoints

### POST /enrollment/enroll
```json
Request: { "device_id": "uuid_v4", "extension_id": "string", "version": "string" }
Response: { "enrollment_token": "string", "secret": "hmac_secret", "expires_at": "iso_date" }
```

### POST /enrollment/refresh
```json
Request: { "enrollment_token": "string", "device_id": "uuid_v4" }
Response: { "enrollment_token": "new_token", "secret": "new_secret", "expires_at": "iso_date" }
```

---

## 3. Execution Endpoints

### POST /execution/request
```json
Request: {
  "action": "generate" | "chatgpt_run" | "grok_run" | "workflow_run",
  "count": 1,
  "owner": "user" | "telegram" | "workflow",
  "label": "string"
}
Response: {
  "allowed": true,
  "token": "execution_token",
  "remaining": 45
}
// OR
Response: {
  "allowed": false,
  "reason": "QUOTA_EXCEEDED",
  "limit": 50,
  "used": 50
}
```

### POST /execution/complete
```json
Request: {
  "token": "execution_token",
  "status": "success" | "failed",
  "metadata": { "error": "string", "tiles_count": 4 }
}
Response: { "ok": true }
```

---

## 4. Entitlements Endpoints

### GET /entitlements
```json
Response: {
  "plan": "free" | "pro" | "premium",
  "features": {
    "gen_enabled": true,
    "chatgpt_enabled": true,
    "grok_enabled": false,
    "workflow_enabled": true,
    "telegram_enabled": false,
    "batch_enabled": true
  },
  "limits": {
    "daily_executions": 50,
    "max_workflow_nodes": 10,
    "max_concurrent_monitors": 4
  },
  "expires_at": "iso_date"
}
```

### GET /entitlements/plans
```json
Response: {
  "plans": [
    {
      "id": "pro",
      "name": "Pro",
      "price": { "monthly": 9.99, "yearly": 99.99, "currency": "USD" },
      "features": {...},
      "limits": {...}
    }
  ]
}
```

---

## 5. Provider Config Endpoints

### GET /provider-configs
```json
Response: {
  "data": {
    "flow": {
      "selectors": {
        "slate_editor": { "selectors": ["div[data-slate-editor]", ".editor-root"] },
        "submit_button": { "selectors": ["button[aria-label='Submit']"] },
        "tile_container": { "selectors": ["[data-tile-id]"], "attribute": "data-tile-id" },
        "warning_icon": { "selectors": ["mat-icon"], "text_match": "warning" }
      },
      "configs": {
        "image_url_pattern": { "url_substring": "getMediaUrlRedirect" },
        "radix_trigger_button_pattern": "button[id$=\"-trigger-{suffix}\"]"
      }
    },
    "chatgpt": { "selectors": {...} },
    "grok": { "selectors": {...} }
  },
  "version": 42
}
```

### GET /provider-configs/api
```json
Response: {
  "data": {
    "flow": {
      "supports": { "ratio": true, "quantity": true, "video": true, "ref_image": true },
      "ratios": [{ "ui_name": "Landscape", "value": "16:9" }],
      "max_ref_images": { "image": 16, "video_ingredients": 8 }
    },
    "chatgpt": {...},
    "grok": {...}
  }
}
```

### GET /provider-configs/models
```json
Response: {
  "providers": {
    "flow": {
      "models": [
        { "id": "omni-flash", "name": "Omni Flash", "config": { "max_ref_images": { "image": 16 } } },
        { "id": "veo-3.1-lite", "name": "Veo 3.1 - Lite", "type": "video" }
      ],
      "default": { "image": "omni-flash", "video": "veo-3.1-lite" }
    }
  }
}
```

---

## 6. Storage Endpoints

### GET /storage/albums
```json
Response: { "albums": [{ "id", "name", "photo_count", "created_at" }] }
```

### POST /storage/albums
```json
Request: { "name": "string" }
Response: { "album": { "id", "name", "created_at" } }
```

### GET /storage/albums/:id/photos
```json
Response: { "photos": [{ "id", "file_name", "thumbnail_url", "album_id", "created_at" }] }
```

### POST /storage/photos
```json
Request: { "album_id": "string", "file_name": "string", "thumbnail_url": "string" }
Response: { "photo": {...} }
```

---

## 7. SSE Endpoints

### GET /sse/connect
```
Headers: Accept: text/event-stream
Query: ?device_id={uuid}&last_event_id={id}

Events:
  event: entitlements_updated
  data: { "features": {...}, "limits": {...} }

  event: provider_config_updated
  data: { "provider": "flow", "version": 43 }

  event: telegram_command
  data: { "command": "/image", "args": {...}, "queue_id": "uuid" }

  event: telegram_cancel
  data: { "queue_id": "uuid" }

  event: payment_confirmed
  data: { "plan": "pro", "expires_at": "iso_date" }

  event: config_version
  data: { "version": 43 }
```

### POST /sse/heartbeat
```json
Request: { "device_id": "uuid" }
Response: { "ok": true }
```

---

## 8. Telegram Endpoints

### POST /telegram/result
```json
Request: {
  "queue_id": "uuid",
  "status": "completed" | "failed",
  "thumbnails": ["url1", "url2"],
  "error": "string (if failed)"
}
Response: { "ok": true }
```

---

## Error Responses

```json
{
  "error": {
    "code": "QUOTA_EXCEEDED" | "UNAUTHORIZED" | "FORBIDDEN" | "INVALID_SIGNATURE" | "RATE_LIMITED",
    "message": "Human-readable error",
    "details": {}
  }
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request / validation error |
| 401 | Unauthorized (invalid/expired JWT) |
| 403 | Forbidden (feature locked, device banned) |
| 429 | Rate limited |
| 503 | Extension not authorized (clone detected) |
