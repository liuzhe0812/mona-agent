use super::{perform_local_http_request, LocalHttpCancellation};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn local_http_cancellation_before_send_does_not_dispatch() {
    let cancellation = LocalHttpCancellation::default();
    cancellation.0.cancel();
    let result = cancellation.run(async {
        panic!("cancelled request must not be sent");
        #[allow(unreachable_code)]
        Ok::<(), String>(())
    }).await;
    assert!(result.unwrap_err().contains("cancelled"));
}

#[tokio::test]
async fn local_http_cancellation_drops_pending_headers_and_body() {
    for send_headers in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0);
            if send_headers {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx").await.unwrap();
            }
            entered_tx.send(()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer)).await;
            assert!(matches!(result, Ok(Ok(0)) | Ok(Err(_))), "request connection remained open");
        });
        let cancellation = Arc::new(LocalHttpCancellation::default());
        let request_cancellation = cancellation.clone();
        let request = tokio::spawn(async move {
            request_cancellation.run(perform_local_http_request(
                "GET".into(), format!("http://{address}/api/file-preview"), vec![], None,
            )).await
        });
        tokio::time::timeout(Duration::from_secs(2), entered_rx).await.unwrap().unwrap();
        cancellation.0.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), request)
            .await.unwrap().unwrap().err().unwrap();
        assert!(error.contains("cancelled"));
        server.await.unwrap();
    }
}

#[test]
fn local_http_cancel_resource_is_scoped_and_released() {
    let mut resources = tauri::ResourceTable::default();
    let id = resources.add(LocalHttpCancellation::default());
    let other_id = resources.add(LocalHttpCancellation::default());
    let cancellation = resources.get::<LocalHttpCancellation>(id).unwrap();
    let other = resources.get::<LocalHttpCancellation>(other_id).unwrap();
    resources.close(id).unwrap();
    assert!(cancellation.0.is_cancelled());
    assert!(!other.0.is_cancelled());
    assert!(resources.get::<LocalHttpCancellation>(id).is_err());
    resources.close(other_id).unwrap();
}
