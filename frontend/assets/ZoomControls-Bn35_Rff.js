import{c as i,j as o}from"./index-BLrDcq6P.js";/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const r=[["polyline",{points:"15 3 21 3 21 9",key:"mznyad"}],["polyline",{points:"9 21 3 21 3 15",key:"1avn1i"}],["line",{x1:"21",x2:"14",y1:"3",y2:"10",key:"ota7mn"}],["line",{x1:"3",x2:"10",y1:"21",y2:"14",key:"1atl0r"}]],x=i("maximize-2",r);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const l=[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["line",{x1:"21",x2:"16.65",y1:"21",y2:"16.65",key:"13gj7c"}],["line",{x1:"11",x2:"11",y1:"8",y2:"14",key:"1vmskp"}],["line",{x1:"8",x2:"14",y1:"11",y2:"11",key:"durymu"}]],a=i("zoom-in",l);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const m=[["circle",{cx:"11",cy:"11",r:"8",key:"4ej97u"}],["line",{x1:"21",x2:"16.65",y1:"21",y2:"16.65",key:"13gj7c"}],["line",{x1:"8",x2:"14",y1:"11",y2:"11",key:"durymu"}]],d=i("zoom-out",m);function u({onZoomIn:n,onZoomOut:t,onFit:c}){const s=[{icon:o.jsx(a,{size:13}),action:n,tip:"Zoom in"},{icon:o.jsx(d,{size:13}),action:t,tip:"Zoom out"},{icon:o.jsx(x,{size:13}),action:c,tip:"Fit"}];return o.jsx("div",{className:"absolute top-3 right-3 z-10 flex flex-col gap-1",children:s.map((e,y)=>o.jsx("button",{onClick:e.action,title:e.tip,className:"bg-white/90 backdrop-blur-sm rounded-md p-1.5 border border-gray-200 hover:bg-white shadow-sm text-slate-500 hover:text-slate-800 transition-colors",children:e.icon},y))})}export{u as Z};
