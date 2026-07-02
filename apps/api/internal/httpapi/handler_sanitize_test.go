package httpapi

import (
	"strings"
	"testing"
)

func TestRenderMarkdownToSafeHTML_PreservesTypographyStyles(t *testing.T) {
	input := `<p><span style="font-family:'Trebuchet MS', Helvetica, sans-serif; font-size: 24px;">Header text</span></p>`

	html, err := renderMarkdownToSafeHTML(input)
	if err != nil {
		t.Fatalf("renderMarkdownToSafeHTML returned error: %v", err)
	}

	if !strings.Contains(html, "<span") {
		t.Fatalf("expected span element to be preserved, got: %s", html)
	}
	if !strings.Contains(html, "font-family") {
		t.Fatalf("expected font-family style to be preserved, got: %s", html)
	}
	if !strings.Contains(html, "font-size") {
		t.Fatalf("expected font-size style to be preserved, got: %s", html)
	}
}

func TestSanitizeHTML_PreservesTextTransformStyle(t *testing.T) {
	input := `<div style="text-transform:capitalize;">title</div>`

	output := sanitizeHTML(input)
	lower := strings.ToLower(output)

	if !strings.Contains(lower, "text-transform") || !strings.Contains(lower, "capitalize") {
		t.Fatalf("expected text-transform style to be preserved, got: %s", output)
	}
}

func TestEnforceTableCellAlignment_InferRightAlignFromImageMargin(t *testing.T) {
	input := `<table><tr><th colspan="1" rowspan="1" style="vertical-align:middle;" valign="middle"><img src="data:image/png;base64,abc" style="width: auto; max-width: none; height: auto; display: block; margin: 8px 0px 8px auto;max-width:100%;width:auto;height:auto;display:block;float:none;"></th></tr></table>`

	output := enforceTableCellAlignment(input)

	if !strings.Contains(output, `align="right"`) {
		t.Fatalf("expected cell align right to be added, got: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), `text-align:right`) {
		t.Fatalf("expected cell text-align:right style to be added, got: %s", output)
	}
}

func TestEnforceTableCellAlignment_InfersLeftAndRightAlignmentFromImageMargins(t *testing.T) {
	input := `<table><tr><th style="width:50%"><img style="display:block; margin: 0 auto 0 0; width: 300px; max-width: 300px; height: auto;" src="https://images.example.com/a.png" width="300" /></th><th style="width:50%"><img style="display:block; margin: 0 0 0 auto; width: 300px; max-width: 300px; height: auto;" src="https://images.example.com/b.png" width="300" /></th></tr></table>`

	output := enforceTableCellAlignment(input)

	if !strings.Contains(output, `align="left"`) {
		t.Fatalf("expected left-aligned th inferred from left image margin, got html: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), `text-align:left`) {
		t.Fatalf("expected left cell text-align:left style, got html: %s", output)
	}
	if !strings.Contains(output, `align="right"`) {
		t.Fatalf("expected right-aligned th inferred from right image margin, got html: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), `text-align:right`) {
		t.Fatalf("expected right cell text-align:right style, got html: %s", output)
	}
}

func TestEnforceTableCellAlignment_InfersAlignmentFromSingleQuotedImageStyle(t *testing.T) {
	input := `<table><tr><th colspan="1" rowspan="1" colwidth="315" style="vertical-align: middle;"><img style='display:block; margin: 0 0 0 auto; width: 300px; max-width: 300px; height: auto;' src='https://images.example.com/right.png' width='300' /></th></tr></table>`

	output := enforceTableCellAlignment(input)

	if !strings.Contains(output, `align="right"`) {
		t.Fatalf("expected right-aligned th inferred from single-quoted image style, got html: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), `text-align:right`) {
		t.Fatalf("expected right cell text-align:right style, got html: %s", output)
	}
}

func TestEnforceTableCellAlignment_InfersAlignmentFromInnerClassAndFloat(t *testing.T) {
	input := `<table><tr><th colspan="1" rowspan="1" colwidth="315" style="vertical-align: middle;"><p class='ql-align-right'>Title</p><img style="display:block; float:right; width: 300px;" src="https://images.example.com/right.png" width="300" /></th></tr></table>`

	output := enforceTableCellAlignment(input)

	if !strings.Contains(output, `align="right"`) {
		t.Fatalf("expected right-aligned th inferred from class/float hints, got html: %s", output)
	}
	if !strings.Contains(strings.ToLower(output), `text-align:right`) {
		t.Fatalf("expected right cell text-align:right style, got html: %s", output)
	}
}

func TestEnforceTableCellAlignment_SwitchesImageDisplayToInlineBlockInAlignedCells(t *testing.T) {
	input := `<table><tr>` +
		`<th align="left" style="text-align: left;"><img src="left.png" style="display: block; margin: 8px auto 8px 0px;"></th>` +
		`<th align="right" style="text-align: right;"><img src="right.png" style="display: block; margin: 8px 0px 8px auto;"></th>` +
		`</tr></table>`

	output := enforceTableCellAlignment(input)

	if !strings.Contains(output, `display: inline-block`) {
		t.Fatalf("expected display:block to be replaced with display:inline-block in aligned cells, got: %s", output)
	}
	if strings.Contains(output, `display: block`) {
		t.Fatalf("expected no display:block images remaining in aligned cells, got: %s", output)
	}
}

func TestEnforceContentTableStyles_SetsTableFullWidth(t *testing.T) {
	input := `<table><tr><td>cell</td></tr></table>`

	output := enforceContentTableStyles(input)

	lower := strings.ToLower(output)
	if !strings.Contains(lower, "width:100%") {
		t.Fatalf("expected table to have width:100%%, got: %s", output)
	}
	if !strings.Contains(lower, "max-width:100%") {
		t.Fatalf("expected table to have max-width:100%%, got: %s", output)
	}
	if !strings.Contains(lower, "table-layout:fixed") {
		t.Fatalf("expected table to have table-layout:fixed, got: %s", output)
	}
	if !strings.Contains(lower, "border-collapse:collapse") {
		t.Fatalf("expected table to have border-collapse:collapse, got: %s", output)
	}
}

func TestSanitizeHTML_PreservesOrderedListStartAttribute(t *testing.T) {
	input := `<ol start="3"><li>Third item</li><li>Fourth item</li></ol>`

	output := sanitizeHTML(input)

	if !strings.Contains(output, `start="3"`) {
		t.Fatalf("expected start attribute to be preserved on ol, got: %s", output)
	}
}

func TestRenderMarkdownToSafeHTML_PreservesOrderedListStartAttribute(t *testing.T) {
	// Pass raw HTML through renderMarkdownToSafeHTML (goldmark passes it through as-is with WithUnsafe)
	input := `<ol start="5"><li>Fifth item</li></ol>`

	html, err := renderMarkdownToSafeHTML(input)
	if err != nil {
		t.Fatalf("renderMarkdownToSafeHTML returned error: %v", err)
	}

	if !strings.Contains(html, `start="5"`) {
		t.Fatalf("expected start attribute to be preserved on ol, got: %s", html)
	}
}

func TestEnforceContentTableStyles_PreservesExistingTableWidth(t *testing.T) {
	input := `<table style="width:50%;border-collapse:collapse;"><tr><td>cell</td></tr></table>`

	output := enforceContentTableStyles(input)

	// ensureStyleIfMissing should not override an already-set width
	if !strings.Contains(output, "width:50%") {
		t.Fatalf("expected existing table width to be preserved, got: %s", output)
	}
}
