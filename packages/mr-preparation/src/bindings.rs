use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = Preparation)]
pub struct WebPreparation(crate::Preparation);

#[wasm_bindgen(js_class = Preparation)]
impl WebPreparation {
    #[wasm_bindgen(constructor)]
    pub fn new(index: &str) -> Result<WebPreparation, JsError> {
        Ok(Self(crate::Preparation::new(index).map_err(error)?))
    }
    pub fn paths(&self) -> Vec<String> {
        self.0.paths().to_vec()
    }
    #[wasm_bindgen(js_name = addModule)]
    pub fn add_module(&mut self, name: &str, bytes: Vec<u8>) -> Result<(), JsError> {
        self.0.add_module(name, bytes).map_err(error)
    }
    pub fn archive(&mut self, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.archive(bytes).map_err(error)
    }
    #[wasm_bindgen(js_name = setSize)]
    pub fn set_size(&mut self, path: &str, size: u32) -> Result<(), JsError> {
        self.0.set_size(path, u64::from(size)).map_err(error)
    }
    pub fn index(&self) -> Result<String, JsError> {
        self.0.index().map_err(error)
    }
}
fn error(error: anyhow::Error) -> JsError {
    JsError::new(&format!("{error:#}"))
}
