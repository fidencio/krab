//! Policy generated from deployment choices, never entered as another UI setting.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    pub name: String,
    pub architectures: Vec<String>,
    pub requirements: Vec<String>,
    #[serde(default)]
    pub gpu_models: Vec<String>,
}
