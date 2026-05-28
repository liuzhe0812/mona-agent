use std::future::Future;

use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::{AgentAuthError, Signer};

use crate::terminal::error::TerminalError;

struct AgentSigner<'a> {
    agent: &'a mut AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>,
}

impl Signer for AgentSigner<'_> {
    type Error = AgentAuthError;

    fn auth_sign(
        &mut self,
        key: &AgentIdentity,
        hash_alg: Option<russh::keys::HashAlg>,
        to_sign: Vec<u8>,
    ) -> impl Future<Output = Result<Vec<u8>, Self::Error>> + Send {
        let key_owned = key.clone();
        async move {
            self.agent
                .sign_request(&key_owned, hash_alg, to_sign)
                .await
                .map_err(Into::into)
        }
    }
}

pub struct SshAgentClient {
    agent: AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>,
}

impl SshAgentClient {
    pub async fn connect() -> Result<Self, TerminalError> {
        #[cfg(unix)]
        {
            let agent = AgentClient::connect_env().await.map_err(|e| {
                TerminalError::AuthFailed(format!(
                    "Failed to connect to SSH Agent: {}. \
                     Make sure SSH_AUTH_SOCK is set and ssh-agent is running.",
                    e
                ))
            })?;
            Ok(Self {
                agent: agent.dynamic(),
            })
        }

        #[cfg(windows)]
        {
            let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
                .await
                .map_err(|e| {
                    TerminalError::AuthFailed(format!(
                        "Failed to connect to SSH Agent via named pipe: {}. \
                         Make sure the OpenSSH Authentication Agent service is running.",
                        e
                    ))
                })?;
            Ok(Self {
                agent: agent.dynamic(),
            })
        }

        #[cfg(not(any(unix, windows)))]
        {
            Err(TerminalError::AuthFailed(
                "SSH Agent is not supported on this platform".into(),
            ))
        }
    }

    pub async fn authenticate(
        &mut self,
        handle: &mut russh::client::Handle<crate::terminal::ssh::client::SshClientHandler>,
        username: &str,
    ) -> Result<(), TerminalError> {
        let keys = self
            .agent
            .request_identities()
            .await
            .map_err(|e| TerminalError::AuthFailed(format!("Failed to list agent keys: {}", e)))?;

        if keys.is_empty() {
            return Err(TerminalError::AuthFailed(
                "SSH Agent has no keys loaded. Add keys with: ssh-add".into(),
            ));
        }

        let mut last_error: Option<String> = None;
        for key in &keys {
            match handle
                .authenticate_publickey_with(
                    username,
                    key.public_key().into_owned(),
                    None,
                    &mut AgentSigner {
                        agent: &mut self.agent,
                    },
                )
                .await
            {
                Ok(result) if result.success() => {
                    return Ok(());
                }
                Ok(_) => {}
                Err(AgentAuthError::Key(e)) => {
                    last_error = Some(format!("{}", e));
                }
                Err(AgentAuthError::Send(e)) => {
                    return Err(TerminalError::AuthFailed(format!(
                        "SSH Agent transport error: {}",
                        e
                    )));
                }
            }
        }

        Err(TerminalError::AuthFailed(format!(
            "No agent key was accepted by the server (tried {} key(s)){}",
            keys.len(),
            last_error
                .map(|e| format!(". Last error: {}", e))
                .unwrap_or_default()
        )))
    }
}

pub fn is_agent_available() -> bool {
    #[cfg(unix)]
    {
        std::env::var("SSH_AUTH_SOCK").is_ok()
    }

    #[cfg(windows)]
    {
        true
    }

    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}
