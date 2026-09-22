#!/usr/bin/env python3
"""ADP WebSocket 对话全链路（独立站/公有云通用）。

用法：
  python3 scripts/ws-chat.py <SecretId> <SecretKey> <AppKey> "对话内容"

链路：CreateWebSocketToken(Type=5, AppKey) → WS(Socket.IO) → 40{token} → chat → 聚合回复
依赖：pip install websocket-client（缺省时用 raw socket 模式）
"""
import base64
import hashlib
import hmac
import json
import sys
import time
import uuid

try:
    import websocket  # websocket-client
except ImportError:
    print("需要安装: pip install websocket-client", file=sys.stderr)
    sys.exit(2)

API_HOST = "adp.tencentcloudapi.com"
WS_URL = "wss://wss.lke.cloud.tencent.com/adp/v2/chat/conn/?language=zh-CN&EIO=4&transport=websocket"


def tc3_headers(secret_id, secret_key, action, payload):
    """腾讯云 TC3-HMAC-SHA256 签名（service=adp）。"""
    ts = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(ts))
    params = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    canonical = (
        "POST\n/\n\ncontent-type:application/json\nhost:" + API_HOST +
        "\nx-tc-action:" + action.lower() + "\n\ncontent-type;host;x-tc-action\n" +
        hashlib.sha256(params.encode("utf-8")).hexdigest()
    )
    scope = f"{date}/adp/tc3_request"
    sts = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n" + hashlib.sha256(canonical.encode()).hexdigest()

    def h(k, m):
        return hmac.new(k, m.encode(), hashlib.sha256).digest()

    k = h(h(h(("TC3" + secret_key).encode(), date), "adp"), "tc3_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    return {
        "Authorization": f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
                         f"SignedHeaders=content-type;host;x-tc-action, Signature={sig}",
        "Content-Type": "application/json",
        "X-TC-Action": action,
        "X-TC-Timestamp": str(ts),
        "X-TC-Version": "2026-05-20",
        "X-TC-Region": "ap-guangzhou",
    }


def get_ws_token(secret_id, secret_key, app_key, user_id="contexta-worker"):
    import urllib.request
    payload = {"Type": 5, "AppKey": app_key, "UserId": user_id}
    headers = tc3_headers(secret_id, secret_key, "CreateWebSocketToken", payload)
    req = urllib.request.Request(
        f"https://{API_HOST}/", data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        resp = json.loads(r.read().decode())
    if "Error" in resp.get("Response", {}):
        e = resp["Response"]["Error"]
        raise RuntimeError(f"CreateWebSocketToken 失败: {e.get('Code')} {e.get('Message')}")
    return resp["Response"]["Token"]


def chat_via_ws(token, text, timeout=60):
    """Socket.IO v4：握手→token鉴权→发对话→聚合 text.delta→完成返回。"""
    ws = websocket.create_connection(WS_URL, timeout=timeout)
    reply = ""
    # 1. 等握手（0{sid}）
    ws.settimeout(10)
    hello = ws.recv()
    assert hello.startswith("0"), f"握手异常: {hello[:80]}"
    # 2. token 鉴权
    ws.send('40{"token":"%s"}' % token)
    # 3. 发对话（Socket.IO event: chat）
    ws.settimeout(timeout)
    deadline = time.time() + timeout
    sent = False
    while time.time() < deadline:
        try:
            msg = ws.recv()
        except Exception:
            break
        if not isinstance(msg, str):
            continue
        if msg.startswith("40"):  # namespace 连接确认 → 发消息
            if not sent:
                conv_id = "ctxa-" + uuid.uuid4().hex[:16]
                body = json.dumps({
                    "RequestId": uuid.uuid4().hex,
                    "ConversationId": conv_id,
                    "VisitorId": "contexta-worker",
                    "Contents": [{"Type": "text", "Text": text}],
                    "Incremental": True, "Stream": "enable",
                }, ensure_ascii=False)
                ws.send('42["chat",' + body + "]")
                sent = True
        elif msg.startswith("42"):
            try:
                name, payload = json.loads(msg[2:])
            except Exception:
                continue
            if name == "error":
                return "", json.dumps(payload, ensure_ascii=False)
            # 兼容事件式与直发式两种
            evt = payload if isinstance(payload, dict) else {}
            t = evt.get("Type", name)
            if t == "text.delta":
                reply += evt.get("Text", "")
            elif t == "text.replace":
                reply = evt.get("Text", reply)
            elif t in ("response.completed", "message.done"):
                if t == "response.completed":
                    break
        elif msg.startswith("2"):  # ping
            ws.send("3")
    ws.close()
    return reply, None


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)
    secret_id, secret_key, app_key, text = sys.argv[1:5]
    print("① 获取 WS Token …")
    token = get_ws_token(secret_id, secret_key, app_key)
    print("  Token:", token[:16], "...")
    print("② WS 连接并发起对话 …")
    reply, err = chat_via_ws(token, text)
    if err:
        print("  ✗ 错误:", err[:300])
        sys.exit(1)
    print("③ 回复:")
    print(reply)


if __name__ == "__main__":
    main()
