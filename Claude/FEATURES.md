# Feature ideas

Candidates for the task DAG editor, roughly in order of value. Done: undo/redo, and the
critical path with slack (toggle with "!").

## Scheduling

### Auto-schedule
One menu item that fills in every missing start and end from durations and
dependencies, from a chosen start date (today the suggestions are accepted one
task at a time). Follow-up: "shift everything after this task by N days/hours".

### Gantt view
The same graph as a timeline: bars on a date axis, arcs between them. Switch
between the graph and the timeline.

## Editing speed

### Arcs from the text field
Create dependencies without clicking, e.g. `Serve dinner after Roast the lamb,
Chill the wine`, or a prefix such as `>` to link a new task to the selected one.

### Keyboard selection
Arrow keys move between boxes, Enter opens the properties panel, Delete removes
the task.

## Organising

### Status and progress
Not started / in progress / done. Done boxes are dimmed; tasks that should have
finished by today but aren't done are flagged.

### Colours or groups
Tag tasks (e.g. "Kitchen", "Venue", "Guests"), shown as a coloured stripe on the
box, with a filter.

### Search
Type to find a task; the view zooms to it.

## Sharing and output

### Export as an image
PNG or SVG of the graph for slides and documents; a print stylesheet.

### Calendar export
Dated tasks as an .ics file to import into a calendar.
