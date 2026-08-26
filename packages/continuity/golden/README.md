# Golden snapshots

One real snapshot per released state version, retained as a file rather than built by a test.

**That is the whole point of them.** A fixture the code constructs agrees with whatever the code now
does, which is the one thing a regression test must not do: it would pass through exactly the change
it exists to catch. These were written once, by the implementation of the day, and are read back
verbatim — so a migration that quietly stops handling a value that was really in the field fails
here rather than in a plant.

A golden snapshot demonstrates a known case. It does not by itself prove a transform is total; that
is what the boundary and property tests beside it are for.

Regenerating one is a deliberate act with a reason recorded in the change that does it, never a way
to make a failure go away.
