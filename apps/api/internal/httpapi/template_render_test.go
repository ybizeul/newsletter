package httpapi

import (
	"strings"
	"testing"
)

func TestRenderNewsletterTemplate_AllowsDataImageIconURL(t *testing.T) {
	htmlBody, err := renderNewsletterHTMLFromTemplate(defaultNewsletterTemplateName, newsletterTemplatePayload{
		ContentWidth: "680",
		IntroHTML:    "<p>Intro</p>",
		Articles: []newsletterTemplateArticle{
			{
				Title:               "Article with icon",
				BodyHTML:            "<p>Body</p>",
				HasIconIllustration: true,
				IconIllustration:    "data:image/png;base64,abc123",
			},
		},
	})
	if err != nil {
		t.Fatalf("renderNewsletterHTMLFromTemplate returned error: %v", err)
	}

	if strings.Contains(htmlBody, "#ZgotmplZ") {
		t.Fatalf("expected no #ZgotmplZ in output, got: %s", htmlBody)
	}
	if !strings.Contains(htmlBody, `src="data:image/png;base64,abc123"`) {
		t.Fatalf("expected icon data URL to be preserved, got: %s", htmlBody)
	}
}

func TestRenderNewsletterTemplate_AllowsSVGDataImageIconURL(t *testing.T) {
	htmlBody, err := renderNewsletterHTMLFromTemplate(defaultNewsletterTemplateName, newsletterTemplatePayload{
		ContentWidth: "680",
		IntroHTML:    "<p>Intro</p>",
		Articles: []newsletterTemplateArticle{
			{
				Title:               "Article with svg icon",
				BodyHTML:            "<p>Body</p>",
				HasIconIllustration: true,
				IconIllustration:    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'></svg>",
			},
		},
	})
	if err != nil {
		t.Fatalf("renderNewsletterHTMLFromTemplate returned error: %v", err)
	}

	if strings.Contains(htmlBody, "#ZgotmplZ") {
		t.Fatalf("expected no #ZgotmplZ in output, got: %s", htmlBody)
	}
	if !strings.Contains(htmlBody, `src="data:image/svg`) {
		t.Fatalf("expected svg data URL src to be preserved, got: %s", htmlBody)
	}
}
