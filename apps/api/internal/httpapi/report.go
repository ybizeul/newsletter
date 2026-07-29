package httpapi

import (
	"fmt"
	"log"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"newsletter/api/internal/model"

	"github.com/xuri/excelize/v2"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// GetReport generates and streams an XLSX report with two sheets:
// "Recipients" (contact-centric) and "Newsletters" (newsletter-centric).
func (h *Handler) GetReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	owner := resolveOwnerEmail(UserFromContext(ctx), "")

	// --- Fetch contacts ---
	contactFilter := contactOwnerFilter(owner)
	contactCursor, err := h.contacts.Find(ctx, contactFilter,
		options.Find().SetSort(bson.D{{Key: "firstName", Value: 1}, {Key: "lastName", Value: 1}}))
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch contacts")
		return
	}
	defer contactCursor.Close(ctx)
	var contacts []model.Contact
	if err := contactCursor.All(ctx, &contacts); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode contacts")
		return
	}

	// --- Fetch headers ---
	headerFilter := headerOwnerFilter(UserFromContext(ctx))
	headerCursor, err := h.headers.Find(ctx, headerFilter)
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch headers")
		return
	}
	defer headerCursor.Close(ctx)
	var headers []model.Header
	if err := headerCursor.All(ctx, &headers); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode headers")
		return
	}

	// Build header ID -> title map
	headerIDToTitle := make(map[string]string)
	for _, h := range headers {
		headerIDToTitle[h.ID] = h.Title
	}

	// --- Fetch newsletters ---
	newsletterFilter := newsletterVisibilityFilter(UserFromContext(ctx))
	newsletterCursor, err := h.newsletters.Find(ctx, newsletterFilter,
		options.Find().SetSort(bson.D{{Key: "sentAt", Value: -1}}))
	if err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to fetch newsletters")
		return
	}
	defer newsletterCursor.Close(ctx)
	var newsletters []model.Newsletter
	if err := newsletterCursor.All(ctx, &newsletters); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to decode newsletters")
		return
	}

	// --- Build email -> sent newsletters mapping ---
	// For each sent newsletter, collect recipient emails.
	type sentEntry struct {
		title  string
		sentAt time.Time
	}
	// Map from lowercase email -> slice of sent newsletters
	emailToSentEntries := make(map[string][]sentEntry)
	// Map from newsletter ID -> actual recipient count (for newsletters with sentAt != nil)
	newsletterRecipientCount := make(map[string]int)

	for _, nl := range newsletters {
		if nl.Status != model.NewsletterStatusSent || nl.SentAt == nil {
			continue
		}
		log.Printf("report: processing newsletter %s (title=%q status=%s sentAt=%v tags=%v)",
			nl.ID, nl.Title, nl.Status, nl.SentAt != nil, nl.ContactTags)

		var recipientEmails []string

		if len(nl.ContactTags) > 0 {
			resolved, err := h.resolveContactRecipients(ctx, owner, nl.ContactTags, nl.ContactTagsMode)
			if err != nil {
				log.Printf("report: failed to resolve contact recipients for newsletter %s: %v", nl.ID, err)
			// Use the newsletter's owner (from when it was sent) to resolve contacts,
			// not the current user's owner, to match the actual send-time behavior
			newsletterOwner := nl.Owner
			resolved, err := h.resolveContactRecipients(ctx, newsletterOwner, nl.ContactTags, nl.ContactTagsMode)
			if err != nil {
				log.Printf("report: failed to resolve contact recipients for newsletter %s: %v", nl.ID, err)
			} else {
				log.Printf("report: newsletter %s (owner=%q tags=%v mode=%q) resolved %d contacts",
					nl.ID, newsletterOwner, nl.ContactTags, nl.ContactTagsMode, len(resolved))
			}
			for _, c := range resolved {
				email := strings.ToLower(strings.TrimSpace(c.Email))
				if email != "" {
					recipientEmails = append(recipientEmails, email)
				}
			}
		} else {
			for _, rid := range nl.RecipientIDs {
				if parsed, err := mail.ParseAddress(strings.TrimSpace(rid)); err == nil {
					recipientEmails = append(recipientEmails, strings.ToLower(parsed.Address))
				} else {
					email := strings.ToLower(strings.TrimSpace(rid))
					if email != "" {
						recipientEmails = append(recipientEmails, email)
					}
				}
			}
		}

		// Store the actual recipient count for this newsletter
		newsletterRecipientCount[nl.ID] = len(recipientEmails)
		log.Printf("report: newsletter %s final recipient count: %d", nl.ID, len(recipientEmails))

		entry := sentEntry{title: nl.Title, sentAt: *nl.SentAt}
		for _, email := range recipientEmails {
			emailToSentEntries[email] = append(emailToSentEntries[email], entry)
		}
	}

	// --- Build the XLSX workbook ---
	f := excelize.NewFile()
	defer f.Close()

	// --- Sheet 1: Recipients ---
	recipientsSheet := "Recipients"
	f.SetSheetName("Sheet1", recipientsSheet)

	recipientHeaders := []string{
		"First Name", "Last Name", "Email", "Tags",
		"Newsletters Sent", "Last Newsletter Title", "Last Contact Date",
	}
	if err := writeHeaderRow(f, recipientsSheet, recipientHeaders); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to write recipients header")
		return
	}

	for i, c := range contacts {
		row := i + 2 // 1-indexed, row 1 is the header
		emailKey := strings.ToLower(strings.TrimSpace(c.Email))

		entries := emailToSentEntries[emailKey]
		sentCount := len(entries)

		var lastTitle string
		var lastDate time.Time
		for _, e := range entries {
			if lastDate.IsZero() || e.sentAt.After(lastDate) {
				lastDate = e.sentAt
				lastTitle = e.title
			}
		}

		tags := strings.Join(c.Tags, ", ")

		cells := []interface{}{
			c.FirstName,
			c.LastName,
			c.Email,
			tags,
			sentCount,
			lastTitle,
		}
		if err := writeRow(f, recipientsSheet, row, cells); err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to write recipient row")
			return
		}
		if !lastDate.IsZero() {
			cell, _ := excelize.CoordinatesToCellName(7, row)
			f.SetCellValue(recipientsSheet, cell, lastDate.Format("2006-01-02"))
		}
	}

	setColumnWidths(f, recipientsSheet, []float64{14, 14, 28, 22, 18, 34, 20})

	// --- Sheet 2: Newsletters ---
	newslettersSheet := "Newsletters"
	f.NewSheet(newslettersSheet)

	newsletterHeaders := []string{
		"Title", "Language", "Header Name", "Template", "Archived", "Link",
		"Sent Date", "Archived Date", "Recipients", "Opens",
	}
	if err := writeHeaderRow(f, newslettersSheet, newsletterHeaders); err != nil {
		h.writeError(w, http.StatusInternalServerError, "failed to write newsletters header")
		return
	}

	for i, nl := range newsletters {
		row := i + 2
		link := ""
		if nl.PublicLink && nl.PublicSlug != "" {
			link = h.newsletterPublicViewURL(nl)
		}

		headerName := ""
		if nl.HeaderID != "" {
			if title, exists := headerIDToTitle[nl.HeaderID]; exists {
				headerName = title
			}
		}

		cells := []interface{}{
			nl.Title,
			string(nl.Language),
			headerName,
			normalizeNewsletterTemplateName(nl.Template),
			nl.Archived,
			link,
		}
		if err := writeRow(f, newslettersSheet, row, cells); err != nil {
			h.writeError(w, http.StatusInternalServerError, "failed to write newsletter row")
			return
		}
		if nl.SentAt != nil {
			cell, _ := excelize.CoordinatesToCellName(7, row)
			f.SetCellValue(newslettersSheet, cell, nl.SentAt.Format("2006-01-02"))
		}
		if nl.ArchivedAt != nil {
			cell, _ := excelize.CoordinatesToCellName(8, row)
			f.SetCellValue(newslettersSheet, cell, nl.ArchivedAt.Format("2006-01-02"))
		}
		colRecipients, _ := excelize.CoordinatesToCellName(9, row)
		f.SetCellValue(newslettersSheet, colRecipients, nl.SentCount)
		// Use tag-resolved recipient count for sent newsletters, fall back to stored count
		recipientCount := nl.SentCount
		if nl.SentAt != nil {
			if count, exists := newsletterRecipientCount[nl.ID]; exists {
				recipientCount = int64(count)
				log.Printf("report: using resolved count for newsletter %s: %d (stored was %d)", nl.ID, count, nl.SentCount)
			} else {
				log.Printf("report: no resolved count found for newsletter %s, using stored %d", nl.ID, nl.SentCount)
			}
		}
		f.SetCellValue(newslettersSheet, colRecipients, recipientCount)
		colOpens, _ := excelize.CoordinatesToCellName(10, row)
		f.SetCellValue(newslettersSheet, colOpens, nl.OpenedUniqueCount)
	}

	setColumnWidths(f, newslettersSheet, []float64{34, 12, 28, 16, 10, 50, 14, 16, 12, 8})

	// --- Stream the file to the client ---
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="report-%s.xlsx"`, time.Now().UTC().Format("2006-01-02")))

	if err := f.Write(w); err != nil {
		// Headers are already sent; log the error for debugging.
		log.Printf("report: failed to write xlsx to response: %v", err)
	}
}

// writeHeaderRow writes a bold header row at row 1 of the given sheet.
func writeHeaderRow(f *excelize.File, sheet string, headers []string) error {
	boldStyle, err := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
	})
	if err != nil {
		return err
	}
	for col, header := range headers {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		if err := f.SetCellValue(sheet, cell, header); err != nil {
			return err
		}
		if err := f.SetCellStyle(sheet, cell, cell, boldStyle); err != nil {
			return err
		}
	}
	return nil
}

// writeRow writes a slice of values starting at column 1 of the given row.
func writeRow(f *excelize.File, sheet string, row int, values []interface{}) error {
	for col, val := range values {
		cell, _ := excelize.CoordinatesToCellName(col+1, row)
		if err := f.SetCellValue(sheet, cell, val); err != nil {
			return err
		}
	}
	return nil
}

// setColumnWidths sets the width of each column. widths[i] is the width for column i+1.
func setColumnWidths(f *excelize.File, sheet string, widths []float64) {
	for i, w := range widths {
		col, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(sheet, col, col, w)
	}
}
