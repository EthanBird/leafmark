# Android 发布签名

Android 只允许签名证书相同的 APK 覆盖更新。LeafMark 的正式构建不得使用 Android Studio
自动生成的 debug keystore；GitHub Actions 缺少固定 release 密钥或证书指纹时会直接停止，
不会发布一个下次无法升级的 APK。

## 一次性生成并备份密钥

在可信的离线环境运行：

```powershell
keytool -genkeypair -v `
  -keystore leafmark-release.jks `
  -storetype JKS `
  -alias leafmark `
  -keyalg RSA `
  -keysize 4096 `
  -validity 10000 `
  -dname "CN=LeafMark, OU=Release, O=LeafMark, C=CN"
```

把 `leafmark-release.jks` 与密码放入两个独立的安全备份位置。丢失私钥后无法再向已安装用户
发布可覆盖升级的 APK。仓库会忽略 `*.jks` 和 `*.keystore`，不得提交私钥。

读取需要固定在 CI 中的公开证书指纹：

```powershell
keytool -J-Duser.language=en -list -v `
  -keystore leafmark-release.jks `
  -alias leafmark
```

记录输出中的 `SHA256`，冒号和字母大小写不影响工作流校验。首次发布前，用这个值替换
`.github/android-signing-cert.sha256` 中的 `UNCONFIGURED` 占位内容并提交。证书指纹不敏感，
把它纳入版本控制可以防止误换全部 Secrets 后悄悄破坏已有用户的升级链；固定签名首版发布后
不得再修改这个文件。

## GitHub Actions Secrets

在仓库 `Settings → Secrets and variables → Actions` 配置：

- `ANDROID_KEYSTORE_BASE64`：JKS 文件的单行 Base64；PowerShell 可用
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("leafmark-release.jks"))`
- `ANDROID_KEYSTORE_PASSWORD`：keystore 密码
- `ANDROID_KEY_ALIAS`：默认是 `leafmark`
- `ANDROID_KEY_PASSWORD`：私钥密码

工作流会把 keystore 与仓库中固定的证书指纹比较，并在构建后再次校验 APK 内的签名证书。
任一值缺失或不一致都会失败。修改密码时可以重新加密同一私钥；不得用新密钥覆盖这些
Secrets，也不得同步修改已发布的固定指纹来绕过检查。

## 从旧临时证书迁移

0.6.0 及更早的 Android APK 使用 CI 临时生成的 debug 证书，其私钥无法恢复。第一次安装固定
release 证书版本时，Android 会拒绝直接覆盖旧包。请先在 LeafMark 中确认重要文档已经导出或
备份，然后卸载旧版并安装新 APK 一次。从固定证书版开始，后续版本即可直接覆盖更新。

发布后可用 Android SDK 验证：

```powershell
apksigner verify --verbose --print-certs LeafMark.apk
adb install -r LeafMark.apk
```
