use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = BuildManifest)]
pub struct WebBuildManifest(crate::BuildManifest);

#[wasm_bindgen(js_class = BuildManifest)]
impl WebBuildManifest {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<WebBuildManifest, JsError> {
        Ok(Self(
            crate::BuildManifest::parse(json.as_bytes()).map_err(error)?,
        ))
    }
    #[wasm_bindgen(getter)]
    pub fn sha256(&self) -> String {
        self.0.sha256().to_owned()
    }
    #[wasm_bindgen(getter, js_name = authoritySha256)]
    pub fn authority_sha256(&self) -> String {
        self.0.authority_sha256().to_owned()
    }
    #[wasm_bindgen(js_name = moduleNames)]
    pub fn module_names(&self) -> Vec<String> {
        self.0.module_names().map(str::to_owned).collect()
    }
    #[wasm_bindgen(js_name = verifyModule)]
    pub fn verify_module(&self, name: &str, bytes: &[u8], target: &str) -> Result<String, JsError> {
        let target = match target {
            "browser" => crate::ModuleTarget::Browser,
            "authority" => crate::ModuleTarget::Authority,
            _ => return Err(JsError::new("Unknown module target")),
        };
        self.0.verify_module(name, bytes, target).map_err(error)
    }
    #[wasm_bindgen(js_name = verifyAuthority)]
    pub fn verify_authority(&self, bytes: &[u8]) -> Result<(), JsError> {
        self.0.verify_authority(bytes).map_err(error)
    }
}

#[wasm_bindgen(js_name = Preparation)]
pub struct WebPreparation(crate::Preparation);

#[wasm_bindgen(js_class = Preparation)]
impl WebPreparation {
    #[wasm_bindgen(constructor)]
    pub fn new(index: &str) -> Result<WebPreparation, JsError> {
        Ok(Self(crate::Preparation::new(index).map_err(error)?))
    }
    pub fn paths(&self) -> Vec<String> {
        self.0.paths()
    }
    #[wasm_bindgen(js_name = addModule)]
    pub fn add_module(&mut self, name: &str, bytes: Vec<u8>) -> Result<(), JsError> {
        self.0.add_module(name, bytes).map_err(error)
    }
    pub fn archive(&mut self, bytes: &[u8]) -> Result<Vec<u8>, JsError> {
        self.0.archive(bytes).map_err(error)
    }
    #[wasm_bindgen(js_name = setSize)]
    pub fn set_size(&mut self, path: &str, size: f64) -> Result<(), JsError> {
        self.0.set_size(path, integer(size)?).map_err(error)
    }
    #[wasm_bindgen(js_name = repackedIndex)]
    pub fn repacked_index(&self) -> Result<String, JsError> {
        self.0.repacked_index().map_err(error)
    }
}
fn error(error: anyhow::Error) -> JsError {
    JsError::new(&format!("{error:#}"))
}

fn integer(value: f64) -> Result<u64, JsError> {
    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=u32::MAX as f64).contains(&value) {
        return Err(JsError::new("Resource index number must be a u32 integer"));
    }
    Ok(value as u64)
}

#[wasm_bindgen(js_name = ResourceIndex)]
pub struct WebResourceIndex(crate::ResourceIndex);

#[wasm_bindgen(js_class = ResourceIndex)]
impl WebResourceIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(text: Option<String>) -> Result<WebResourceIndex, JsError> {
        Ok(Self(match text {
            Some(text) => crate::ResourceIndex::parse(&text).map_err(error)?,
            None => crate::ResourceIndex::default(),
        }))
    }
    pub fn paths(&self) -> Vec<String> {
        self.0
            .entries()
            .iter()
            .map(|entry| entry.path.clone())
            .collect()
    }
    pub fn add(&mut self, path: &str, sector: f64, size: f64) -> Result<(), JsError> {
        self.0
            .add(path, integer(sector)?, integer(size)?)
            .map_err(error)
    }
    #[wasm_bindgen(js_name = setSize)]
    pub fn set_size(&mut self, path: &str, size: f64) -> Result<(), JsError> {
        self.0.set_size(path, integer(size)?).map_err(error)
    }
    pub fn require(&self, path: &str, size: f64) -> Result<(), JsError> {
        self.0.require(path, integer(size)?).map_err(error)
    }
    pub fn repack(&mut self, first_sector: f64) -> Result<(), JsError> {
        self.0.repack(integer(first_sector)?).map_err(error)
    }
    #[wasm_bindgen(js_name = toTsv)]
    pub fn to_tsv(&self) -> Result<String, JsError> {
        self.0.to_tsv().map_err(error)
    }
}
