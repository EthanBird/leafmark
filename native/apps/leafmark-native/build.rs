fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let is_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let is_release = std::env::var("PROFILE").as_deref() == Ok("release");
    if is_windows && is_release {
        println!("cargo:rustc-link-arg-bin=leafmark-native=/SUBSYSTEM:WINDOWS");
        println!("cargo:rustc-link-arg-bin=leafmark-native=/ENTRY:mainCRTStartup");
    }
}
