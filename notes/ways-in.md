# Ways in

*A design note, written before anything is built, about showing a node's **other** interfaces in the console — a web UI, a REST API, an SSH endpoint — and about what has to be true before a viewer may reach one.*

## The question

The console is a good browser of a network: it finds peers, draws what they expose from their own contract, and lets somebody call a method and see the answer. The question is how much else it can carry. A node often has more than its RPC surface — a configuration page, a REST API, a terminal — and an operator holding the console is exactly the person who wants them.

So: can the same UI hold those, and what is the shape that does not make a mess?

## What is already here

`msgrpc.describe` **is** the "swagger call" that `new stuff.md` asked for in July, and the console is the scanner-with-a-dialog beside it. Both were built as this library's own shape rather than borrowed: `contracts.md` says why, and it is not squeamishness — *"OpenAPI is HTTP-shaped and cannot describe a server pushing events; AsyncAPI models everything as a channel"*. Nothing here speaks HTTP as a protocol, and nothing here should start.

`ObjectBinding` already answers most of the modelling question, and its own documentation states the case exactly: *"An aspect says where does this appear when I look at the system this way; a binding says through what interface can I observe or act on it. A pump has one identity, several aspects, and may be reachable over OPC UA, over Sparkplug and as a Source RPC component at the same time. **None of those is a structure.**"* `BindingTarget` already carries `{ type: 'external', system, id, endpoint? }`.

And the console already draws bindings in a section of their own, under *reachable through* — with no buttons, deliberately: *"a binding says how an object can be reached, not that this page may reach it, and drawing a button would turn a description into an invitation."*

## The shape

**Not child nodes.** The first instinct — a second list of API children, kept apart from the true children — was right about the *separation* and it is worth noticing that the separation already exists: the bindings section is that second list. What it should not become is a branch of the tree. A node's SSH endpoint is not an object that appears in a functional or location arrangement; it is a way in to an object that does. Putting it in the tree beside `Line 1 filler` conflates identity with access, which is the conflation the aspects package exists to refuse.

**Not a new aspect, in the direction being asked.** An "integration" arrangement whose objects genuinely *are* endpoints is a legitimate aspect — somebody browsing the estate's interfaces is browsing a set of objects. But "how do I reach this pump" is a property of the pump. The test: is the reader browsing *the interfaces*, or browsing *the plant* and asking how to reach a thing? The second is a binding, and the second is the case here.

**Not the word `capability`.** It is taken, by `AspectProvider.capability()`, for the protocol handshake a viewer reads before asking anything. A second meaning on the same word in the same package is how two vocabularies for one question start.

So: richer binding kinds, drawn in the section that already exists. `http.ui`, `http.openapi`, `ssh`, whatever a deployment has — namespaced by whoever owns the interface, exactly as `opcua.node` and `sparkplug.metric` already are.

## Three grades of reach, and they are not one decision

This is the part worth getting right before any of it is built, because the three are routinely conflated and they have nothing in common but a URL.

**Named.** The console says the endpoint exists, and shows it as text somebody can copy. This is what happens today. It crosses no boundary: the operator learns a fact the node published, and does whatever they do next in their own tools. The whole of the current bindings section is this grade, and it is already useful.

**Navigated.** The console hands the address to the browser — an ordinary link, opening in a tab of its own. The console embeds nothing, renders nothing, and fetches nothing. The browser makes the request as itself, with whatever session the operator already has, against an origin that is not the console's. Almost all of the value of this whole idea is at this grade, and almost none of the risk.

**Acted on.** The console fetches, embeds or proxies: an iframe of the node's UI, a rendered OpenAPI page with a *try it* button, a terminal. Here the console stops being a viewer and becomes a client of somebody else's interface, on behalf of an operator, from a page that holds a live link to the whole network.

The design mistake to avoid is treating these as three settings of one feature. They are three features with one input, and a deployment that wants the second does not thereby want the third.

## Default closed, and how an admin opens it

The default is no. Not as caution, but because a viewer that reaches a node's interfaces *because it can* is an ambient-authority gateway, and the library's whole authorization model is the opposite of that: authority is a property of the call, asserted and checked, never a property of being connected.

The mechanism for opening it should not be invented. It exists, as the AI grants document, and its shape is already the right shape:

- **A path, not flags** — *"the document is the point: a console can render data and cannot render a callback, and a reviewer can diff it"*.
- **Absent means closed.** *"A grant that is absent is closed — that is the whole default."*
- **Schema-versioned with a monotonic revision**, refused rather than guessed at, because it is a security artifact and a rollback should be visible.
- **`to` / `roles`**, so a deployment grants by name or by role.
- **`expiresAt`**, with standing grants possible, visible, and deliberately not the ergonomic default — *"a commissioning afternoon should be a lease somebody renews on purpose rather than configuration archaeology nobody remembers granting"*.
- **`reason`**, for the audit trail and for whoever reads the file in six months.
- **SIGHUP re-reads it**, so opening a rung does not need a restart of the thing being operated.

A reachability document would say the same things about a different subject: which binding *kinds*, at which *grade*, for which peers or roles, until when, and why. `ssh` navigated but never embedded; `http.ui` embedded for the commissioning role until Friday; `http.openapi` named only. That is a sentence an administrator can write, review and revoke, and it is one a reviewer can diff.

## The origin problem, which is a deployment fact

If embedding is ever reached, one thing has to be settled first and it is not a code detail.

The console is deliberately **one port — page and RPC over the same origin**. That is a good decision for what it was made for and a bad one to inherit here: a frame on the console's origin sits beside the socket.io endpoint and the console's `localStorage`. Anything embedded must therefore be served from a **different origin** — a different port or subdomain — with `sandbox` and without `allow-same-origin` against the console's, and a CSP `frame-src` naming what may be framed at all.

The second half is authentication. A tunnel that terminates at the console and forwards with the console's own credentials makes the console a confused deputy: the operator's reach becomes whatever the console can reach, which is everything. Whatever the tunnel is, it should carry the *operator's* identity to the far end, not the console's. This is the hard part of the idea and it is the part worth designing first, because a tunnel built the easy way is very difficult to un-build.

## What to build first, and what it proves

**Declare the bindings and draw them as links.** Grade two, no tunnel, no origin question, no sanitizing decision. A node says `kind: 'http.ui'` with an endpoint, and the console renders a link that opens in a new tab.

This is a small change and it tests the actual hypothesis — *is it useful for the node browser to know where a thing's UI lives* — within an afternoon, without deciding anything that is hard to reverse. If the answer is no, nothing was spent. If the answer is yes, the next question is a real one asked with evidence.

It also forces the one deliberate reversal this idea requires: the console currently draws bindings with no button *on purpose*. Making some of them navigable is a change to that rule, and the honest version of the change distinguishes handing an address to the browser from the console acting on it — which is exactly the grade distinction above, arriving as the first line of code rather than as a later regret.

**Then, and only with the grant document in place, one embed.** A localhost site, on its own origin, sandboxed, for one binding kind, opened by a grant with an expiry. That is the smallest thing that answers whether embedding is worth its cost.

## What would be wrong

Making the library speak HTTP. The contract format's refusal of OpenAPI is not about OpenAPI; it is about not having two protocols. A binding names an endpoint and the *viewer* may know what to do with it — an OpenAPI panel is a console feature reading a document, not the library learning REST.

Rendering a node's OpenAPI document and calling the result a contract. It is somebody else's description of somebody else's surface; `describe()` remains the thing this network is browsed by.

And treating a tunnel as plumbing. It is the security boundary of the whole idea, and if it is added last it will be added as whatever was easiest.
