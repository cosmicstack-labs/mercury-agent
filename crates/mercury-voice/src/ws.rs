//! WebSocket connect with custom headers (rustls + ring, like the WhatsApp plugin).

use tokio_websockets::{ClientBuilder, MaybeTlsStream, WebSocketStream};
use tokio::net::TcpStream;

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(url: &str, headers: &[(&str, String)]) -> Result<Socket, String> {
    let uri: http::Uri = url.parse().map_err(|e| format!("bad URL: {e}"))?;
    let mut b = ClientBuilder::from_uri(uri);
    for (name, value) in headers {
        let n = http::HeaderName::from_bytes(name.as_bytes()).map_err(|e| e.to_string())?;
        let v = http::HeaderValue::from_str(value).map_err(|e| e.to_string())?;
        b = b.add_header(n, v).map_err(|e| e.to_string())?;
    }
    let (ws, _) = b.connect().await.map_err(|e| e.to_string())?;
    Ok(ws)
}
