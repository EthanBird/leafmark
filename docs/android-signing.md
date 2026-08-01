# Android 发布签名

Android 只允许签名证书相同的 APK 覆盖更新。从 LeafMark 0.7.0 开始，官方 GitHub Release
固定使用仓库内的 `LeafMark Community Update Key v1`。证书有效期至 2126 年，SHA-256
指纹固定为：

```text
68:d7:80:73:6d:ce:e9:17:40:e0:8c:24:69:d4:ad:7a:
0f:52:90:32:c3:73:ca:1e:c4:3e:6c:1e:7f:21:4c:e7
```

## 为什么密钥在仓库中

项目目前没有受保护的正式发布证书。为保证每次 GitHub Actions 构建都能覆盖安装，项目选择
一个长期固定、公开可复现的社区更新密钥：

- `.github/leafmark-community-release.jks.b64` 是 JKS 的 Base64 文本；
- `.github/android-signing-cert.sha256` 固定公开证书指纹；
- 发布工作流在构建前和 APK 生成后各校验一次指纹；
- alias 为 `leafmark-community`，公开密码为 `leafmark-community-release-v1`。

这个方案只提供“后续版本使用同一 Android 更新身份”，**不提供发布者真实性或私钥保密性**。
任何获得仓库内容的人理论上都能用该密钥签名同 applicationId 的 APK。请只从项目的官方
GitHub Releases 下载，并在安装前核对 Release 页面、提交与哈希。未来若改用受保护的正式
证书，由于 Android 的签名规则，需要新 applicationId 或受支持的签名迁移流程。

## 本机构建

先把仓库中的 Base64 文本还原为临时 JKS，再构建 ARM64 APK：

```powershell
[IO.File]::WriteAllBytes(
  "$env:TEMP\leafmark-community-release-v1.jks",
  [Convert]::FromBase64String(
    (Get-Content .github\leafmark-community-release.jks.b64 -Raw).Trim()
  )
)
$env:ANDROID_KEYSTORE_PATH = "$env:TEMP\leafmark-community-release-v1.jks"
$env:ANDROID_KEYSTORE_PASSWORD = "leafmark-community-release-v1"
$env:ANDROID_KEY_ALIAS = "leafmark-community"
$env:ANDROID_KEY_PASSWORD = "leafmark-community-release-v1"
npm run tauri -- android build --apk --target aarch64 --split-per-abi
```

发布后可用 Android SDK 验证：

```powershell
apksigner verify --verbose --print-certs LeafMark.apk
adb install -r LeafMark.apk
```

## 从旧临时证书迁移

0.6.0 及更早 Android APK 的 debug 私钥无法恢复，所以第一次安装 0.7.0 时 Android 会拒绝
覆盖旧包。请先确认重要文档已经导出或备份，卸载旧 APK 后安装 0.7.0。此后只要继续使用上面
固定的社区证书，就可以直接覆盖更新。
