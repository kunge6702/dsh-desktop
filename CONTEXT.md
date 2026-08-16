# DSH Desktop

DSH Desktop packages and presents a local DSH experience as a desktop application.

## Language

**Desktop Shell**:
The installed application that owns the desktop lifecycle around a local DSH Runtime.
_Avoid_: Client, wrapper

**DSH Runtime**:
The versioned local DSH distribution embedded in and started by the Desktop Shell.
_Avoid_: Backend, server

**Workspace**:
The user-selected directory in which the DSH Runtime operates and keeps project work.
_Avoid_: Project, working directory

**Application Release**:
A stable, user-installable version of the Desktop Shell, distinct from the embedded DSH Runtime version.
_Avoid_: Runtime release, build

**Update**:
A newer stable Application Release offered to an installed Desktop Shell.
_Avoid_: Upgrade, runtime update
