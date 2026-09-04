---
title: The guide
topics: overview, guide
---

# The guide

The ordered read, roughly in the order the questions arrive.

[Getting started](getting-started.md) is one peer and one call. [Connecting](connecting.md) is how peers find each other, over a socket or a broker, and [MQTT](mqtt.md) is the broker case in full. [Exposing methods](exposing.md) and [contracts](contracts.md) are what a peer publishes about itself, which is what lets a console draw a form for a method it has never seen.

[Components](components.md) is the half people underestimate: a peer is as much what it *holds* as what it can be told to do, and a component is state somebody watches rather than polls. [Data providers](data-providers.md) are the collections too large or dynamic for that snapshot. [Events](events.md) is the other direction. [Commands](commands.md) and [long work](long-work.md) are calls that change something and calls that take a while, which are different problems.

[Authority](authority.md) and [security](security.md) are who may do what. [Topology](topology.md) and [context](context.md) are where a node sits and what is true around it. [Reference](reference.md) is the index.

Read in that order it is a morning. Read one file at a time it is whatever the question was.
