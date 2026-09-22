#!/usr/bin/env python3
"""ADP AppKey 全链路诊断（官方云 API，V3 签名，纯标准库）。

用法：
  python3 scripts/verify-adp.py <SecretId> <SecretKey> <AppKey> [AppId]

依次执行：
  1. DescribeRobotBizIDByAppKey(AppKey)  —— 复现对话网关的机器人解析（460004 机制）
  2. DescribeApp(FieldMask=SecretInfo)   —— 取权威 AppKey（对照用户复制的 key 是否一致）
  3. /adp/v2/chat SSE 实测               —— 用解析出的信息直接发起一次对话

参考：官方 adp-chat-client 的 get_info()（DescribeRobotBizIDByAppKey → BotBizId）。
"""
import hashlib
import hmac
import json
import sys
import time
import uuid
from urllib.request import Request, urlopen

# 云 API 通用参数
LKE_HOST = "lke.tencentcloudapi.com"        # 机器人解析（旧 LKE 服务）
ADP_HOST = "adp.tencentcloudapi.com"        # 应用管理
CHAT_URL = "https://wss.lke.cloud.tencent.com/adp/v2/chat"


def v3_sign(secret_id, secret_key, host, service, action, version, region, payload):
    """腾讯云 TC3-HMAC-SHA256 签名。"""
    ts = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(ts))
    params = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    canonical = (
        f"POST\n/\n\n"
        f"content-type:application/json\n"
        f"host:{host}\n"
        f"x-tc-action:{action.lower()}\n"
        f"\ncontent-type;host;x-tc-action\n"
        + hashlib.sha256(params.encode("utf-8")).hexdigest()
    )
    scope = f"{date}/{service}/tc3_request"
    string_to_sign = (
        f"TC3-HMAC-SHA256\n{ts}\n{scope}\n"
        + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    )

    def _hmac(key, msg):
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    secret_date = _hmac(("TC3" + secret_key).encode("utf-8"), date)
    secret_service = _hmac(secret_date, service)
    secret_signing = _hmac(secret_service, "tc3_request")
    signature = hmac.new(
        secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    auth = (
        f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
        f"SignedHeaders=content-type;host;x-tc-action, Signature={signature}"
    )
    return {
        "Authorization": auth,
        "Content-Type": "application/json",
        "X-TC-Action": action,
        "X-TC-Timestamp": str(ts),
        "X-TC-Version": version,
        "X-TC-Region": region,
    }


def call_api(host, service, action, version, region, secret_id, secret_key, payload):
    headers = v3_sign(secret_id, secret_key, host, service, action, version, region, payload)
    req = Request(f"https://{host}/", data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        body = ""
        if hasattr(e, "read"):
            try:
                body = e.read().decode("utf-8")[:500]
            except Exception:
                pass
        return {"_exception": str(e), "_body": body}


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    secret_id, secret_key, app_key = sys.argv[1], sys.argv[2], sys.argv[3]
    app_id = sys.argv[4] if len(sys.argv) > 4 else None

    print("=" * 60)
    print("步骤 1：DescribeRobotBizIDByAppKey（对话网关的机器人解析机制）")
    r = call_api(LKE_HOST, "lke", "DescribeRobotBizIDByAppKey", "2023-11-30", "ap-guangzhou",
                 secret_id, secret_key, {"AppKey": app_key})
    resp = r.get("Response", {})
    if "Error" in resp:
        print(f"  ✗ 解析失败：{resp['Error'].get('Code')} {resp['Error'].get('Message')}")
        print("    → 与对话网关 460004 同源：该 AppKey 在 LKE 侧无对应机器人")
    else:
        print(f"  ✓ BotBizId = {resp.get('BotBizId')}")
        print("    → 机器人存在，AppKey 可用于对话")
    print(f"  RequestId: {resp.get('RequestId', r.get('_body', '')[:120])}")

    print("=" * 60)
    print("步骤 2：DescribeApp(FieldMask=SecretInfo)（权威 AppKey 对照）")
    if app_id:
        r2 = call_api(ADP_HOST, "adp", "DescribeApp", "2026-05-20", "ap-guangzhou",
                      secret_id, secret_key, {"AppId": app_id, "FieldMask": {"Paths": ["SecretInfo", "Status"]}})
        resp2 = r2.get("Response", {})
        if "Error" in resp2:
            print(f"  ✗ {resp2['Error'].get('Code')} {resp2['Error'].get('Message')}")
        else:
            real_key = (resp2.get("SecretInfo") or {}).get("AppKey", "")
            status = resp2.get("Status") or {}
            print(f"  App 状态: {status.get('Status')} {status.get('StatusDescription')}")
            masked = real_key[:8] + "..." + real_key[-6:] if real_key else "(空)"
            print(f"  权威 AppKey: {masked}")
            print(f"  与传入 key 一致: {'是' if real_key == app_key else '否 ← 用户复制的 key 与平台不一致！'}")
    else:
        print("  （未传 AppId，跳过）")

    print("=" * 60)
    print("步骤 3：/adp/v2/chat SSE 实测（用传入 AppKey）")
    body = json.dumps({
        "RequestId": uuid.uuid4().hex,
        "ConversationId": "verify-" + uuid.uuid4().hex[:16],
        "AppKey": app_key,
        "Contents": [{"Type": "text", "Text": "回复 OK 即可"}],
        "VisitorId": "contexta-verify",
        "Stream": "enable",
    }).encode("utf-8")
    req = Request(CHAT_URL, data=body,
                  headers={"Content-Type": "application/json", "Accept": "text/event-stream"}, method="POST")
    try:
        with urlopen(req, timeout=60) as resp3:
            text = resp3.read().decode("utf-8")
            print(text[:600])
    except Exception as e:
        body_txt = ""
        if hasattr(e, "read"):
            try:
                body_txt = e.read().decode("utf-8")[:400]
            except Exception:
                pass
        print(f"  请求异常: {e}\n{body_txt}")


if __name__ == "__main__":
    main()
