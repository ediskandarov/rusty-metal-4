#[cfg(target_family = "wasm")]
mod browser;
pub mod input;
#[cfg(any(target_family = "wasm", all(test, feature = "client")))]
#[cfg_attr(not(target_family = "wasm"), allow(dead_code))]
mod live_prediction;
#[cfg(any(target_family = "wasm", test))]
mod prediction_input;
pub mod protocol;

#[cfg(feature = "rollback_probe")]
pub mod rollback_probe;
