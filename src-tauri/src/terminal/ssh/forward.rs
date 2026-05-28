use std::sync::Arc;

use russh::client::Handle;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::terminal::error::TerminalError;
use crate::terminal::ssh::client::SshClientHandler;

pub struct PortForward {
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    forward_type: ForwardType,
}

#[derive(Debug, Clone)]
pub enum ForwardType {
    Local { local_port: u16, remote_host: String, remote_port: u16 },
    Remote { remote_port: u16, local_host: String, local_port: u16 },
}

impl PortForward {
    pub fn new(handle: Handle<SshClientHandler>, forward_type: ForwardType) -> Self {
        Self {
            handle: Arc::new(Mutex::new(handle)),
            forward_type,
        }
    }

    pub fn new_from_arc(
        handle: Arc<Mutex<Handle<SshClientHandler>>>,
        forward_type: ForwardType,
    ) -> Self {
        Self {
            handle,
            forward_type,
        }
    }

    pub async fn start_local(&self) -> Result<u16, TerminalError> {
        let (local_port, remote_host, remote_port) = match &self.forward_type {
            ForwardType::Local { local_port, remote_host, remote_port } => {
                (*local_port, remote_host.clone(), *remote_port)
            }
            _ => return Err(TerminalError::SshConnection("Not a local forward".into())),
        };

        let listener = TcpListener::bind(format!("127.0.0.1:{}", local_port))
            .await
            .map_err(|e| TerminalError::SshConnection(format!("Bind failed: {}", e)))?;

        let actual_port = listener
            .local_addr()
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?
            .port();

        let handle = self.handle.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(s) => s,
                    Err(_) => break,
                };

                let handle = handle.clone();
                let remote_host = remote_host.clone();
                tokio::spawn(async move {
                    if let Err(e) =
                        forward_local_to_remote(stream, handle, &remote_host, remote_port).await
                    {
                        log::warn!("Local forward error: {}", e);
                    }
                });
            }
        });

        Ok(actual_port)
    }
}

async fn forward_local_to_remote(
    local_stream: TcpStream,
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    remote_host: &str,
    remote_port: u16,
) -> Result<(), TerminalError> {
    let channel = {
        let h = handle.lock().await;
        h.channel_open_direct_tcpip(remote_host, remote_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?
    };

    let (mut channel_read, mut channel_write) = channel.split();
    let (mut local_read, mut local_write) = local_stream.into_split();

    let client_to_remote = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 8192];
        loop {
            match local_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if channel_write.data(&buf[..n]).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = channel_write.eof();
    });

    let remote_to_client = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        loop {
            match channel_read.wait().await {
                Some(russh::ChannelMsg::Data { data }) => {
                    if local_write.write_all(&data).await.is_err() {
                        break;
                    }
                }
                Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) => break,
                None => break,
                _ => {}
            }
        }
        let _ = local_write.shutdown().await;
    });

    let _ = tokio::try_join!(client_to_remote, remote_to_client);
    Ok(())
}
