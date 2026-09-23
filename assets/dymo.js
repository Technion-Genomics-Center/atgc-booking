// The DYMO LabelWriter, when the computer printing has one.
//
// DYMO Connect for Desktop runs a small service on this machine at
// https://127.0.0.1:41951. A page may talk to it, and it prints a label
// exactly as laid out - no print dialog, no paper-size guessing, which is what
// browser printing could not do: Windows only offers DYMO's own label sizes and
// ours (38 x 19 mm CryoSTUCK, LWCS503) is not one of them.
//
// The layout below was settled at the printer on 2026-09-23, label by label:
// the tube's label in bold, then its name, then the PI, with the date reading
// up the left edge. Sizes are inches, as DYMO's own template file gives them.
//
// Nothing here is required: where no DYMO answers, the page prints in the
// browser as before.
(function () {
  "use strict";

  var SERVICE = "https://127.0.0.1:41951/DYMO/DLS/Printing/";
  var LABEL = "LWCS503";                    // 38 x 19 mm, the lab's tube labels
  var AREA = { x: 0.060000032, y: 0.045, w: 1.38, h: 0.675 };
  var DATE_BOX = { x: 0.05, y: 0.10, w: 0.13, h: 0.61 };
  var TEXT_BOX = { x: 0.19, y: 0.10, w: 1.23, h: 0.61 };
  var SIZES = { label: 10.1, name: 7.9, pi: 7.9, date: 5.4 };

  var found = null;                         // the answer, asked for once

  function xml(text) {
    return String(text == null ? "" : text).replace(/[<>&"']/g, function (c) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }

  function post(op, body, ms) {
    var stop = new AbortController();
    var timer = setTimeout(function () { stop.abort(); }, ms || 8000);
    return fetch(SERVICE + op, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
      signal: stop.signal,
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error(op + " " + r.status);
      return r.text();
    });
  }

  function span(text, size, bold) {
    return "<LineTextSpan><TextSpan><Text>" + xml(text) + "</Text><FontInfo>" +
      "<FontName>Arial</FontName><FontSize>" + size + "</FontSize>" +
      "<IsBold>" + (bold ? "True" : "False") + "</IsBold><IsItalic>False</IsItalic>" +
      "<IsUnderline>False</IsUnderline><FontBrush><SolidColorBrush>" +
      '<Color A="1" R="0" G="0" B="0"/></SolidColorBrush></FontBrush>' +
      "</FontInfo></TextSpan></LineTextSpan>";
  }

  function textObject(name, box, spans, align, rotation) {
    return "<TextObject><Name>" + name + "</Name><Brushes>" +
      '<BackgroundBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"/></SolidColorBrush></BackgroundBrush>' +
      '<BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"/></SolidColorBrush></BorderBrush>' +
      '<StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"/></SolidColorBrush></StrokeBrush>' +
      '<FillBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"/></SolidColorBrush></FillBrush>' +
      "</Brushes><Rotation>" + rotation + "</Rotation>" +
      "<OutlineThickness>1</OutlineThickness><IsOutlined>False</IsOutlined>" +
      "<BorderStyle>SolidLine</BorderStyle>" +
      '<Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>' +
      "<HorizontalAlignment>" + align + "</HorizontalAlignment>" +
      "<VerticalAlignment>Middle</VerticalAlignment><FitMode>None</FitMode>" +
      "<IsVertical>False</IsVertical><FormattedText><FitMode>None</FitMode>" +
      "<HorizontalAlignment>" + align + "</HorizontalAlignment>" +
      "<VerticalAlignment>Middle</VerticalAlignment><IsVertical>False</IsVertical>" +
      spans.join("") + "</FormattedText><ObjectLayout><DYMOPoint>" +
      "<X>" + box.x + "</X><Y>" + box.y + "</Y></DYMOPoint><Size>" +
      "<Width>" + box.w + "</Width><Height>" + box.h + "</Height></Size>" +
      "</ObjectLayout></TextObject>";
  }

  // One sticker: {label, name, pi, date}.
  function labelXml(sticker) {
    var lines = [span(sticker.label, SIZES.label, true)];
    if (sticker.name) lines.push(span(sticker.name, SIZES.name, false));
    if (sticker.pi) lines.push(span(sticker.pi, SIZES.pi, false));
    return '<?xml version="1.0" encoding="utf-8"?>' +
      '<DesktopLabel Version="1"><DYMOLabel Version="4">' +
      "<Description>ATGC tube label</Description>" +
      "<Orientation>Landscape</Orientation><LabelName>" + LABEL + "</LabelName>" +
      "<InitialLength>0</InitialLength><BorderStyle>SolidLine</BorderStyle>" +
      "<DYMORect><DYMOPoint><X>" + AREA.x + "</X><Y>" + AREA.y + "</Y></DYMOPoint>" +
      "<Size><Width>" + AREA.w + "</Width><Height>" + AREA.h + "</Height></Size></DYMORect>" +
      '<BorderColor><SolidColorBrush><Color A="1" R="0" G="0" B="0"/></SolidColorBrush></BorderColor>' +
      "<BorderThickness>1</BorderThickness><Show_Border>False</Show_Border>" +
      "<HasFixedLength>False</HasFixedLength><FixedLengthValue>0</FixedLengthValue>" +
      "<DynamicLayoutManager><RotationBehavior>ClearObjects</RotationBehavior><LabelObjects>" +
      textObject("DATE", DATE_BOX, [span(sticker.date, SIZES.date, false)], "Center", "Rotation90") +
      textObject("TEXT", TEXT_BOX, lines, "Left", "Rotation0") +
      "</LabelObjects></DynamicLayoutManager></DYMOLabel>" +
      "<LabelApplication>Blank</LabelApplication>" +
      "<DataTable><Columns></Columns><Rows></Rows></DataTable></DesktopLabel>";
  }

  function form(fields) {
    return Object.keys(fields).map(function (k) {
      return k + "=" + encodeURIComponent(fields[k]);
    }).join("&");
  }

  // The printer's name, or null where there is none. Asked once per page load.
  function printer() {
    if (found) return found;
    found = post("StatusConnected", undefined, 4000).then(function (text) {
      if (text.indexOf("true") < 0) throw new Error("no DYMO");
      return post("GetPrinters", undefined, 4000);
    }).then(function (printers) {
      var name = /<Name>([^<]+)<\/Name>/.exec(printers);
      var connected = /<IsConnected>([^<]+)<\/IsConnected>/.exec(printers);
      if (!name || !connected || connected[1].toLowerCase() !== "true") throw new Error("no DYMO");
      return name[1];
    }).catch(function () { return null; });
    return found;
  }

  // Print the stickers, one after another. Resolves false where there is no
  // DYMO, so the caller can print in the browser instead.
  function print(stickers) {
    return printer().then(function (name) {
      if (!name) return false;
      return stickers.reduce(function (wait, sticker) {
        return wait.then(function () {
          return post("PrintLabel", form({
            printerName: name,
            printParamsXml: "<LabelWriterPrintParams><Copies>1</Copies>" +
              "<JobTitle>ATGC Booking</JobTitle><FlowDirection>LeftToRight</FlowDirection>" +
              "<PrintQuality>Text</PrintQuality></LabelWriterPrintParams>",
            labelXml: labelXml(sticker),
            labelSetXml: "",
          }), 20000);
        });
      }, Promise.resolve()).then(function () { return true; });
    });
  }

  window.Dymo = { printer: printer, print: print, labelXml: labelXml };
})();
