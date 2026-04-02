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
