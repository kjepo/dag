# dag

A browser editor for dependency graphs (DAGs) of moments: type the names of moments, connect them, and Graphviz lays them out. A moment is a single point in time: it has a date (or a date and time) but no start, end or duration. (This is the `moment` branch; `main` has the task version, where boxes have a start, a duration and an end.)

Live at https://monsym.se/dag/. Plain HTML + jQuery, with [viz.js](https://github.com/mdaines/viz-js) for the layout; no build step. Open `index.html` through any static web server. Example graphs are in `examples/` (open them with ☰ → Open…).
