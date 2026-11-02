//! ACP v1 client host for Remote ACP Bridge.
//!
//! Launches an allowlisted ACP agent subprocess, speaks newline-delimited
//! JSON-RPC 2.0 over its stdio, correlates requests/responses, streams
//! session updates with backpressure and routes agent->client requests
//! (permissions, fs) to a local [`ClientHandler`].

pub mod acp;
pub mod framing;
pub mod host;
pub mod mock;

pub use host::{AgentCommand, AgentHost, ClientError, ClientHandler, HostError, HostEvent, Limits};
