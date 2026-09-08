#set page(paper: "a4", margin: 22mm)
#set text(size: 11pt, fill: rgb("243247"))
#set heading(numbering: "1.")
#show heading: set text(fill: rgb("176c89"))
#align(right)[DOCUMENT NOTES / 01]
#v(14mm)
#text(size: 30pt, weight: "bold")[From source\ to PDF]
#v(3mm)
#text(size: 14pt, fill: rgb("176c89"))[A reading and revision workflow]
#v(10mm)
= Keep the document in view
Read the generated PDF beside its source. After a revision, rebuild the document to see the updated pages in the viewer.

= Inspect the details
Zoom into a figure or equation, then return to the surrounding text. An outline gives the document structure; search finds a phrase across pages.
#v(5mm)
#block(fill: rgb("edf5f7"), inset: 16pt, width: 100%)[
  *A simple model*
  $ f(x) = integral_0^x (1 + t^2) dif t = x + x^3 / 3 $
  The accumulated value grows as the input increases.
]
#v(6mm)
#table(columns: (1fr, 1fr, 1fr), inset: 10pt,
  [*Input*], [*Value*], [*Revision*],
  [0], [0.00], [Draft],
  [1], [1.33], [Draft],
  [2], [4.67], [Draft],
)
#pagebreak()
= Review a revision
The PDF is one output of the source document. Keep the source and output together so that changes are easy to inspect.

== Reading checklist
- Check the section headings.
- Search for repeated terminology.
- Inspect equations at a larger zoom.
- Review the updated PDF after each build.
#v(8mm)
#block(fill: rgb("edf5f7"), inset: 16pt, width: 100%)[
  *Revision status: Draft*

  The next revision will mark this document as reviewed.
]
#pagebreak()
= Further reading
Use the outline or thumbnails to return to a section. Follow internal links to revisit an earlier part of the document.

The source for this sample is included in the MuPDF Viewer repository.
