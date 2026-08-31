---
title: Source RPC documentation
topics: overview
---

# Source RPC documentation

What is in this folder, and which end to pick it up by.

[The guide](guide/getting-started.md) is the ordered read: a peer, a call, a component somebody watches, and the contract that lets a console draw all three without having seen the source. Start there if you are starting.

Everything beside it is a reference rather than a chapter, and each answers one question. [Deploying a network](deploying-a-network.md) is where peers actually go. [The security model](security-model.md) is who may do what, and why authority is a property of the call rather than of the connection. [Schema compatibility](schema-compatibility.md) is what may change without breaking somebody who is already running. The two frame specifications — [flat](flat-frame-spec.md) and [MQTT 5](mqtt5-frame-spec.md) — are what goes on the wire, and [wire format parity](wire-format-parity.md) is the claim that both say the same thing.

[The tools](tools/console.md) are the CLI, the console and the MCP surface, which are three ways of holding the same network.

This file is also the one a document library opens when somebody browses this folder, which is the point of a README having something in it.
