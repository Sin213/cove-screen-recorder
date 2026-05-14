use serde::Serialize;

/// A parsed incoming JSON-RPC message.
///
/// `is_notification` is true when the `id` field is entirely absent from the message.
/// This is the only way to distinguish a notification (no id) from a request with
/// `id: null` (present but null), which JSON-RPC 2.0 treats differently.
#[derive(Debug)]
pub struct Request {
    /// The id value if `id` was present; `None` if the field was absent.
    /// When `is_notification` is false and this is `None`, the id was `null`.
    pub id: Option<serde_json::Value>,
    /// True when the `id` key was completely absent (JSON-RPC notification).
    /// False for requests, even if `id` is null.
    pub is_notification: bool,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

/// Parse raw bytes as a JSON-RPC request or notification.
pub fn parse_request(bytes: &[u8]) -> anyhow::Result<Request> {
    let v: serde_json::Value = serde_json::from_slice(bytes)?;
    let obj = v
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("JSON-RPC message must be a JSON object"))?;

    let is_notification = !obj.contains_key("id");
    let id = obj.get("id").cloned();
    let method = obj
        .get("method")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("missing or non-string method field"))?
        .to_string();
    let params = obj.get("params").cloned();

    Ok(Request { id, is_notification, method, params })
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    #[serde(flatten)]
    pub body: ResponseBody,
}

impl Response {
    pub fn result(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Response {
            jsonrpc: "2.0".into(),
            id,
            body: ResponseBody::Result { result },
        }
    }

    pub fn error(id: Option<serde_json::Value>, error: RpcError) -> Self {
        Response {
            jsonrpc: "2.0".into(),
            id,
            body: ResponseBody::Error { error },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum ResponseBody {
    Result { result: serde_json::Value },
    Error { error: RpcError },
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    /// Integer for protocol errors (e.g. -32600), string "not-implemented" for stubs.
    pub code: serde_json::Value,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl RpcError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        RpcError {
            code: serde_json::Value::Number((-32600).into()),
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found() -> Self {
        RpcError {
            code: serde_json::Value::Number((-32601).into()),
            message: "method not found".into(),
            data: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl Notification {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Notification {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
        }
    }
}
