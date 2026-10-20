# Geocoding report

Written by `scripts/geocode.py` each time the data is rebuilt.

- Shelters: 377
- Located: 377
- Need review: 3

Each row below is a shelter whose PDF address and postal code disagree, or that OneMap could not find.
The site currently uses the **postal code** location. If the address is right instead, add a fix to
`CORRECTIONS` in `scripts/parse_pdf.py`.

| Shelter | Address | Postal code | Status | OneMap for postal code | OneMap for address | Gap |
|---|---|---|---|---|---|---|
| Watten Hub | Bougainvillea Park, 500 Dunearn Rd | 289618 | postal_not_found_used_address | not found | BOUGAINVILLEA PARK | - |
| Marsiling Zone '9' RN | 185 Woodlands St 13 #02-671 | 732185 | minor: block letter differs | 185B WOODLANDS STREET 13 MARSILING GREENVIEW SINGAPORE 732185 | 185 WOODLANDS STREET 13 MARSILING GREENVIEW SINGAPORE 730185 | 51 m |
| East Canberra Zone 1 RN | 107 Canberra Street #01-567 | 751107 | minor: block letter differs | 107A CANBERRA STREET EASTBROOK @ CANBERRA SINGAPORE 751107 | 107 CANBERRA STREET EASTBROOK @ CANBERRA SINGAPORE 750107 | 32 m |
